#!/usr/bin/env bash
# Sprint 10 E2E — 内嵌 HTML / CSS 渲染（v0.2.7 核心）
#
# 在真实 Chromium（agent-browser）中验证：
#   1. 内嵌 HTML（div/details/figure）进入 .preview-content 包裹层
#   2. style 属性真实生效（getComputedStyle 颜色断言）
#   3. <style> 块产出 <style data-user-css> 且选择器已前缀化
#   4. 用户 CSS 真实命中预览区内容（作用域语义正确）
#   5. 作用域隔离（核心安全）：#windowControls / body 不可被用户 CSS 命中
#   6. 攻击面剥除：@import / 外发 url / position:fixed 全部失效
#   7. XSS 回归：script / onclick / svg data URL
#   8. data:image base64 直通、svg+xml 拒绝
#   9. 回归：链接拦截 / 编辑器输入不受包裹层影响

set -uo pipefail

cd "$(dirname "$0")/.."
PROJECT=$(pwd)

if ! command -v agent-browser >/dev/null 2>&1; then
    echo "❌ 错误: agent-browser CLI 未安装或不在 PATH 中"
    exit 2
fi

if [ ! -d frontend/dist ]; then
    echo "❌ 缺少 frontend/dist，请先执行: cd frontend && npm run build"
    exit 2
fi

PASS=0
FAIL=0

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
log()  { echo; echo "── $1 ──"; }

ev()  { agent-browser eval "$1" 2>&1 | tail -1; }
evs() { agent-browser eval "$1" 2>&1 | tail -1 | sed -e 's/^"//' -e 's/"$//'; }

BASE=http://127.0.0.1:5174/dev.html

open_page() {
    local url="$BASE"
    [ -n "${1:-}" ] && url="$BASE?open=$1"
    agent-browser open "$url" > /dev/null 2>&1
    sleep 2.5
}

inject() {
    agent-browser eval "(() => { window.__litemd__mockfs.setFile($1, $2); return 1; })()" > /dev/null 2>&1
}

# ============================================================================
log "Step 0: vite preview 启动检查"
if ! curl -sf -o /dev/null "$BASE"; then
    cd frontend && (nohup npx vite preview --port 5174 --strictPort > /tmp/vite_sprint10.log 2>&1 &) && cd ..
    sleep 4
fi
curl -sf -o /dev/null "$BASE" && echo "vite=200" || { echo "vite=DOWN"; exit 2; }

# ============================================================================
log "Step 1: 准备 mock 文档库"
# v0.2.11 修复：必须在打开应用、确认 mockfs 就绪**之后**再执行 setFile。
# 原脚本在 open 之前就 inject——浏览器无页面（agent-browser close 后）或页面
# 尚未加载完时 eval 抛错且被 >/dev/null 静默吞掉，文档根本没写进去；随后
# open ?open=/css.md 找不到文件，后续依赖文档元素的断言全部连锁失败
# （querySelector 落空 → fallback 读 body，把应用自身的主题渐变误读为
# "外发背景图生效"，产生假阳性安全告警）。
agent-browser open "$BASE" > /dev/null 2>&1
READY=""
for i in 1 2 3 4 5; do
    READY=$(agent-browser eval "typeof window.__litemd__mockfs" 2>/dev/null | tail -1 | tr -d '"')
    [[ "$READY" == "object" ]] && break
    sleep 1
done
if [[ "$READY" == "object" ]]; then
    echo "  mockfs=ready"
else
    echo "❌ mockfs 未就绪（应用未加载完成），终止"
    exit 2
fi
CSSDOC='# 内嵌渲染测试\n\n<div class=\"md-hl\">作用域高亮</div>\n\n<details><summary>折叠</summary>详情内容</details>\n\n<span style=\"color: red\">红字</span>\n\n<div class=\"t\">定位测试</div>\n\n<style>\n.md-hl { color: rgb(2, 170, 80); }\n#meta { display: none; }\nbody { background: rgb(255, 0, 0); }\n@import url(\"https://evil.example/x.css\");\n.t { background: url(\"https://evil.example/t.png\"); position: fixed; }\n@keyframes kf { from { opacity: 0 } to { opacity: 1 } }\n</style>\n\n<img src=\"data:image/png;base64,iVBORw0KGgo=\" alt=\"b64\">\n\n<img src=\"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=\" alt=\"svg\">\n\n<script>alert(1)</script>\n\n<div onclick=\"alert(1)\">点击窃取</div>\n'
inject "'/css.md'" "\"$CSSDOC\""
echo "  mock 文档已注入"

open_page "/css.md"
ACTIVE=$(evs "window.__litemd__tm.active?.path")
[[ "$ACTIVE" == "/css.md" ]] && ok "测试文档已打开: $ACTIVE" || fail "文档未打开: $ACTIVE"

# ============================================================================
log "场景 1: 内嵌 HTML 进入 .preview-content 包裹层"
WRAP=$(ev "!!document.querySelector('.preview > .preview-content')")
[[ "$WRAP" == "true" ]] && ok "包裹层 .preview-content 存在且为 .preview 直接子元素" || fail "包裹层缺失: $WRAP"

DETAILS=$(ev "!!document.querySelector('.preview-content details summary')")
[[ "$DETAILS" == "true" ]] && ok "details/summary 渲染保留" || fail "details/summary 缺失: $DETAILS"

# ============================================================================
log "场景 2: style 属性真实生效"
SPAN_COLOR=$(evs "getComputedStyle([...document.querySelectorAll('.preview-content span')].find(x => x.textContent === '红字') || document.body).color")
[[ "$SPAN_COLOR" == "rgb(255, 0, 0)" ]] && ok "style=color:red 计算样式生效: $SPAN_COLOR" || fail "颜色未生效: $SPAN_COLOR"

# ============================================================================
log "场景 3: <style> 块产出 data-user-css 且已前缀化"
STYLE_TAG=$(evs "(document.querySelector('.preview-content style[data-user-css]')?.textContent || '').slice(0, 400)")
[[ -n "$STYLE_TAG" ]] && ok "<style data-user-css> 已插入 DOM" || fail "style 标签缺失"
[[ "$STYLE_TAG" == *".preview-content .md-hl"* ]] && ok "选择器已前缀化到预览区作用域" || fail "前缀缺失: $STYLE_TAG"
[[ "$STYLE_TAG" == *".preview-content {"* ]] && ok "body 选择器映射为前缀本体" || fail "body 映射缺失: $STYLE_TAG"

# ============================================================================
log "场景 4: 用户 CSS 真实命中预览区内容"
HL_COLOR=$(evs "getComputedStyle(document.querySelector('.preview-content .md-hl') || document.body).color")
[[ "$HL_COLOR" == "rgb(2, 170, 80)" ]] && ok "用户 CSS 规则生效: .md-hl → $HL_COLOR" || fail "用户 CSS 未生效: $HL_COLOR"

# ============================================================================
log "场景 5: 作用域隔离（核心安全断言）"
# 注：不用 #windowControls 做探针——mock 模式下它本来就被应用自身隐藏（index.html 注释）
WC_DISPLAY=$(evs "getComputedStyle(document.getElementById('meta')).display")
[[ "$WC_DISPLAY" != "none" ]] && ok "✅ #meta（标题栏状态区）未被用户 CSS 隐藏（display=$WC_DISPLAY）" || fail "🔴 标题栏元素被用户 CSS 隐藏！"

BODY_BG=$(evs "getComputedStyle(document.body).backgroundColor")
[[ "$BODY_BG" != "rgb(255, 0, 0)" ]] && ok "✅ body 背景未被污染（$BODY_BG）" || fail "🔴 body 背景被用户 CSS 改写！"

PREVIEW_OUT=$(evs "getComputedStyle(document.querySelector('.split-editor') || document.getElementById('meta') || document.body).backgroundColor")
[[ -n "$PREVIEW_OUT" ]] && ok "预览区外元素计算样式可正常读取（隔离不影响应用自身）" || fail "预览区外元素读取异常"

# ============================================================================
log "场景 6: 攻击面剥除（@import / 外发 url / position:fixed）"
[[ "$STYLE_TAG" != *"@import"* && "$STYLE_TAG" != *"evil.example"* ]] && ok "✅ @import 与外发 url 全部剥除" || fail "🔴 @import / 外发 url 残留: $STYLE_TAG"

T_POS=$(evs "getComputedStyle(document.querySelector('.preview-content .t') || document.body).position")
[[ "$T_POS" != "fixed" ]] && ok "✅ position:fixed 未生效（.t 实际 position=$T_POS）" || fail "🔴 position:fixed 生效，UI 欺骗风险！"

T_BG=$(evs "getComputedStyle(document.querySelector('.preview-content .t') || document.body).backgroundImage")
[[ "$T_BG" == "none" || "$T_BG" == "" ]] && ok "✅ 外发 background-image 未生效（$T_BG）" || fail "🔴 外发背景图生效: $T_BG"

KF=$(evs "([...document.querySelectorAll('style[data-user-css]')].map(s => s.textContent).join('').includes('@keyframes kf')) + ''")
[[ "$KF" == "true" ]] && ok "@keyframes 结构保留（动画定义不破坏）" || fail "@keyframes 被误伤: $KF"

# ============================================================================
log "场景 7: XSS 回归"
SCRIPT_N=$(ev "document.querySelectorAll('.preview-content script').length")
[[ "$SCRIPT_N" == "0" ]] && ok "<script> 未进入 DOM" || fail "🔴 script 进入 DOM（$SCRIPT_N 个）！"

ONCLICK=$(evs "(document.querySelector('.preview-content div[onclick]') ? 'yes' : 'no')")
[[ "$ONCLICK" == "no" ]] && ok "onclick 属性被剥除" || fail "🔴 onclick 残留！"

# ============================================================================
log "场景 8: data URI 图片"
B64_SRC=$(evs "(document.querySelector('.preview-content img[alt=b64]')?.getAttribute('src') || '')")
[[ "$B64_SRC" == "data:image/png;base64,iVBORw0KGgo=" ]] && ok "data:image/png base64 直通" || fail "base64 图片被误剥: $B64_SRC"

SVG_SRC=$(evs "(document.querySelector('.preview-content img[alt=svg]')?.getAttribute('src') || 'removed')")
[[ "$SVG_SRC" == "removed" ]] && ok "data:image/svg+xml 的 src 被收窄剥除" || fail "svg data URL 残留: $SVG_SRC"

# ============================================================================
log "场景 9: 回归 — 编辑器输入与链接拦截不受包裹层影响"
agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: 0, insert: '# 回归标题\\n\\n'}}); return 1; })()" > /dev/null 2>&1
sleep 1.2
H1=$(evs "([...document.querySelectorAll('.preview-content h1')].some(h => (h.textContent || '').includes('回归标题'))) + ''")
[[ "$H1" == "true" ]] && ok "编辑器输入 → 预览实时更新正常（包裹层不阻断）" || fail "预览未更新: $H1"

agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: v.state.doc.length, insert: '\\n\\n[回归链接](https://example.com/reg)'}}); return 1; })()" > /dev/null 2>&1
sleep 1.2
agent-browser eval "(() => { const a = [...document.querySelectorAll('.preview-content a[href]')].find(x => (x.getAttribute('href')||'').includes('example.com')); if (a) a.click(); return 1; })()" > /dev/null 2>&1
sleep 1.5
PATHNAME=$(evs "location.pathname")
EXT=$(evs "JSON.stringify(window.__litemd__mockfs.externalOpens)")
[[ "$PATHNAME" == "/dev.html" && "$EXT" == *"example.com"* ]] && ok "外链拦截 + OpenExternal 正常（v0.2.6 行为保持）" || fail "链接行为异常: path=$PATHNAME ext=$EXT"

# ============================================================================
echo
echo "════════════════════════════════"
echo "Sprint 10 结果：$PASS 通过，$FAIL 失败"
echo "════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
