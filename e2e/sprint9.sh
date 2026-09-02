#!/usr/bin/env bash
# Sprint 9 E2E — 预览链接跳转修复（v0.2.6 核心）
#
# 背景：预览区的 [文本](../../文档名) 此前会让 WebView 就地导航到
# http://wails.localhost/文档名 → assetserver 404 → 前端 SPA 被卸载
# （界面卡死、未保存内容丢失）。本套断言锁死"任何链接点击都不发生导航"。
#
#   1. 相对 Markdown 链接 → 应用内打开目标文档（核心）
#   2. 外链 → 走 OpenExternal，不导航
#   3. 非文档文件 → 二次确认后交系统程序；取消则不打开
#   4. 不存在的文件 → 明确提示，不导航
#   5. 锚点链接 → 预览区滚动（含标题 id 生成）
#   6. 未保存文档点击相对链接 → 引导先保存
#   7. 中键 auxclick 同样被拦截
#   8. 相对路径图片 → 解析为 data URL（不再破图）
#   9. 回归：wiki-link 点击仍可跳转
#  10. 回归：链接拦截不误伤编辑器输入

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

# 打开页面（可带 ?open=<path> 让 mock 以文件关联方式打开，从而有真实 basePath）
open_page() {
    local url="$BASE"
    [ -n "${1:-}" ] && url="$BASE?open=$1"
    agent-browser open "$url" > /dev/null 2>&1
    sleep 2.5
}

# 注入 mock 文件（写入 mockfs + sessionStorage，刷新后仍存在）
inject() {
    agent-browser eval "(() => { window.__litemd__mockfs.setFile($1, $2); return 1; })()" > /dev/null 2>&1
}

# 清空外部打开记录，保证场景间互不干扰
reset_calls() {
    agent-browser eval "(() => { const f = window.__litemd__mockfs; f.externalOpens.length = 0; f.systemOpens.length = 0; return 1; })()" > /dev/null 2>&1
}

# ============================================================================
log "Step 0: vite preview 启动检查"
if ! curl -sf -o /dev/null "$BASE"; then
    cd frontend && (nohup npx vite preview --port 5174 --strictPort > /tmp/vite_sprint9.log 2>&1 &) && cd ..
    sleep 4
fi
curl -sf -o /dev/null "$BASE" && echo "vite=200" || { echo "vite=DOWN"; exit 2; }

# ============================================================================
log "Step 1: 准备 mock 文档库"
open_page
inject "'/vault/notes/main.md'" "'[举例](../../文档名)\n\n[外链](https://example.com)\n\n[PDF](../files/a.pdf)\n\n[坏链](../nope.md)\n'"
inject "'/文档名'" "'# 目标文档\n\n来自相对链接跳转。\n'"
inject "'/vault/files/a.pdf'" "'%PDF-1.4 fake'"
inject "'/img.png'" "'fake-png-bytes'"
inject "'/mock/sib.md'" "'# 双链目标\n'"
echo "  mock 文件已注入"

# ============================================================================
log "场景 1: 相对 Markdown 链接在应用内打开（核心修复）"
reset_calls
open_page "/vault/notes/main.md"
ACTIVE=$(evs "window.__litemd__tm.active?.path")
[[ "$ACTIVE" == "/vault/notes/main.md" ]] && ok "启动文件已打开: $ACTIVE" || fail "启动文件未打开: $ACTIVE"

LINK_HREF=$(evs "document.querySelector('.preview a[href]')?.getAttribute('href')")
# marked 会把中文 href 做 percent 编码（../../%E6%96%87%E6%A1%A3%E5%90%8D）
[[ "$LINK_HREF" == *"../../%E6%96%87%E6%A1%A3%E5%90%8D"* ]] && ok "预览渲染出相对链接 href: $LINK_HREF" || fail "相对链接缺失: $LINK_HREF"

agent-browser eval "(() => { const a = [...document.querySelectorAll('.preview a[href]')].find(x => decodeURIComponent(x.getAttribute('href')||'').includes('文档名')); a.click(); return 1; })()" > /dev/null 2>&1
sleep 1.8

PATHNAME=$(evs "location.pathname")
[[ "$PATHNAME" == "/dev.html" ]] && ok "✅ 点击后未发生页面导航（pathname 仍为 /dev.html）" || fail "发生了导航: $PATHNAME"

ACTIVE2=$(evs "window.__litemd__tm.active?.path")
[[ "$ACTIVE2" == "/文档名" ]] && ok "相对链接跳转到了目标文档: $ACTIVE2" || fail "未跳转到目标文档: $ACTIVE2"

TAB_TITLE=$(evs "window.__litemd__tm.active?.title")
[[ "$TAB_TITLE" == "文档名" ]] && ok "标签标题正确: $TAB_TITLE" || fail "标签标题异常: $TAB_TITLE"

# ============================================================================
log "场景 2: 外链走系统浏览器，不导航"
reset_calls
open_page "/vault/notes/main.md"
agent-browser eval "(() => { const a = [...document.querySelectorAll('.preview a[href]')].find(x => (x.getAttribute('href')||'').startsWith('https://')); a.click(); return 1; })()" > /dev/null 2>&1
sleep 1.5
EXT=$(evs "JSON.stringify(window.__litemd__mockfs.externalOpens)")
[[ "$EXT" == *"example.com"* ]] && ok "OpenExternal 已调用: $EXT" || fail "未调用 OpenExternal: $EXT"
PATHNAME=$(evs "location.pathname")
[[ "$PATHNAME" == "/dev.html" ]] && ok "外链点击未导航" || fail "外链触发了导航: $PATHNAME"

# ============================================================================
log "场景 3: 非文档文件二次确认（确认 → 打开 / 取消 → 不打开）"
reset_calls
open_page "/vault/notes/main.md"
agent-browser eval "(() => { const a = [...document.querySelectorAll('.preview a[href]')].find(x => (x.getAttribute('href')||'').endsWith('.pdf')); a.click(); return 1; })()" > /dev/null 2>&1
sleep 1.5
DLG_OPEN=$(evs "document.getElementById('linkConfirmDialog')?.open")
[[ "$DLG_OPEN" == "true" ]] && ok "弹出二次确认对话框" || fail "未弹出确认对话框: $DLG_OPEN"
DLG_BODY=$(evs "document.getElementById('linkConfirmBody')?.textContent")
[[ "$DLG_BODY" == *"a.pdf"* ]] && ok "确认框显示目标路径: $DLG_BODY" || fail "确认框路径异常: $DLG_BODY"

# 先测取消
agent-browser eval "(() => { const d = document.getElementById('linkConfirmDialog'); d.querySelector('button[value=\\'cancel\\']').click(); return 1; })()" > /dev/null 2>&1
sleep 1
SYS_AFTER_CANCEL=$(evs "JSON.stringify(window.__litemd__mockfs.systemOpens)")
[[ "$SYS_AFTER_CANCEL" == "[]" ]] && ok "取消后未打开系统程序" || fail "取消后仍打开了: $SYS_AFTER_CANCEL"

# 再测确认
agent-browser eval "(() => { const a = [...document.querySelectorAll('.preview a[href]')].find(x => (x.getAttribute('href')||'').endsWith('.pdf')); a.click(); return 1; })()" > /dev/null 2>&1
sleep 1.5
agent-browser eval "(() => { document.getElementById('linkConfirmDialog').querySelector('button[value=\\'open\\']').click(); return 1; })()" > /dev/null 2>&1
sleep 1.5
SYS=$(evs "JSON.stringify(window.__litemd__mockfs.systemOpens)")
[[ "$SYS" == *"a.pdf"* ]] && ok "确认后交系统默认程序: $SYS" || fail "确认后未打开: $SYS"

# ============================================================================
log "场景 4: 不存在的文件给出提示且不导航"
reset_calls
open_page "/vault/notes/main.md"
agent-browser eval "(() => { const a = [...document.querySelectorAll('.preview a[href]')].find(x => (x.getAttribute('href')||'').includes('nope.md')); a.click(); return 1; })()" > /dev/null 2>&1
sleep 1.5
ERR_OPEN=$(evs "document.getElementById('errorDialog')?.open")
ERR_TITLE=$(evs "document.getElementById('errorTitle')?.textContent")
[[ "$ERR_OPEN" == "true" && "$ERR_TITLE" == "文件不存在" ]] && ok "提示「文件不存在」" || fail "提示异常: open=$ERR_TITLE"
PATHNAME=$(evs "location.pathname")
[[ "$PATHNAME" == "/dev.html" ]] && ok "断链点击未导航" || fail "断链触发导航: $PATHNAME"
agent-browser eval "(() => { document.getElementById('errorDialog').querySelector('button')?.click(); return 1; })()" > /dev/null 2>&1

# ============================================================================
log "场景 5: 锚点链接滚动（含标题 id 生成）"
open_page
# 注意：填充行之间必须有空行（每行成为独立段落），否则 marked 会把连续
# 文本行合并进一个 <p>，预览内容不溢出、scrollTop 恒为 0，滚动无从发生
agent-browser eval "(() => { const v = window.__litemd__cm.view; const body = '[跳转](#目标标题)\n\n' + Array.from({length: 60}, (_, i) => '填充行 ' + i + '\n').join('\n') + '\n## 目标标题\n\n正文。'; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: body}}); return 1; })()" > /dev/null 2>&1
sleep 1.2
H_ID=$(evs "document.querySelector('.preview h2')?.id")
MAXS=$(evs "document.getElementById('preview').scrollHeight - document.getElementById('preview').clientHeight")
[[ -n "$H_ID" && "$H_ID" != "null" ]] && ok "标题已自动生成 id: $H_ID" || fail "标题缺少 id: $H_ID"
[[ "${MAXS:-0}" -gt 0 ]] && ok "预览内容可滚动（maxScroll=$MAXS）" || fail "预览内容未溢出，无法验证滚动"
SCROLL_BEFORE=$(evs "Math.round(document.getElementById('preview').scrollTop)")
agent-browser eval "(() => { const a = document.querySelector('.preview a[href^=\\'#\\']'); a.click(); return 1; })()" > /dev/null 2>&1
sleep 1.2
SCROLL_AFTER=$(evs "Math.round(document.getElementById('preview').scrollTop)")
[[ "${SCROLL_AFTER:-0}" -gt "${SCROLL_BEFORE:-0}" ]] && ok "锚点点击后预览区滚动: $SCROLL_BEFORE → $SCROLL_AFTER" || fail "锚点未滚动: $SCROLL_BEFORE → $SCROLL_AFTER"

# ============================================================================
log "场景 6: 未保存文档点击相对链接 → 引导先保存"
open_page
agent-browser eval "(() => { window.__litemd__tm.newTab(); const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: '[相对](../y.md) 链接'}}); return 1; })()" > /dev/null 2>&1
sleep 1.5
BASE_PATH=$(evs "window.__litemd__tm.active?.path")
[[ -z "$BASE_PATH" || "$BASE_PATH" == "null" ]] && ok "当前为未保存文档（path 为空）" || fail "期望未保存文档, 实际: $BASE_PATH"
agent-browser eval "(() => { document.querySelector('.preview a[href]').click(); return 1; })()" > /dev/null 2>&1
sleep 1.5
ERR_TITLE=$(evs "document.getElementById('errorTitle')?.textContent")
[[ "$ERR_TITLE" == "请先保存文档" ]] && ok "提示「请先保存文档」" || fail "提示异常: $ERR_TITLE"
PATHNAME=$(evs "location.pathname")
[[ "$PATHNAME" == "/dev.html" ]] && ok "未保存文档点击链接未导航" || fail "触发导航: $PATHNAME"
agent-browser eval "(() => { document.getElementById('errorDialog').querySelector('button')?.click(); return 1; })()" > /dev/null 2>&1

# ============================================================================
log "场景 7: 中键点击（auxclick）同样被拦截"
open_page "/vault/notes/main.md"
agent-browser eval "(() => { const a = [...document.querySelectorAll('.preview a[href]')].find(x => (x.getAttribute('href')||'').includes('文档名')); a.dispatchEvent(new MouseEvent('auxclick', {bubbles: true, cancelable: true, button: 1})); return 1; })()" > /dev/null 2>&1
sleep 1.5
PATHNAME=$(evs "location.pathname")
[[ "$PATHNAME" == "/dev.html" ]] && ok "中键点击未导航" || fail "中键触发导航: $PATHNAME"

# ============================================================================
log "场景 8: 相对路径图片解析为 data URL"
open_page
agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: '# 图片\\n\\n![本地图](/img.png)\\n'}}); return 1; })()" > /dev/null 2>&1
sleep 2
IMG_SRC=$(evs "(document.querySelector('.preview img')?.getAttribute('src') || '').slice(0, 22)")
[[ "$IMG_SRC" == "data:image/png;base64," ]] && ok "本地图片已回填 data URL" || fail "图片未回填: $IMG_SRC"

# ============================================================================
log "场景 9: 回归 — wiki-link 点击仍可跳转"
open_page
agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: '[[sib]]'}}); return 1; })()" > /dev/null 2>&1
sleep 1.2
WIKI_N=$(evs "document.querySelectorAll('.preview .wiki-link').length")
[[ "${WIKI_N:-0}" -ge 1 ]] && ok "wiki-link 渲染正常: $WIKI_N" || fail "wiki-link 缺失: $WIKI_N"
agent-browser eval "(() => { document.querySelector('.preview .wiki-link').click(); return 1; })()" > /dev/null 2>&1
sleep 1.8
WIKI_ACTIVE=$(evs "window.__litemd__tm.active?.title")
[[ "$WIKI_ACTIVE" == "sib.md" ]] && ok "wiki-link 跳转到 sib.md" || fail "wiki-link 未跳转: $WIKI_ACTIVE"
PATHNAME=$(evs "location.pathname")
[[ "$PATHNAME" == "/dev.html" ]] && ok "wiki-link 点击未导航" || fail "wiki-link 触发导航: $PATHNAME"

# ============================================================================
log "场景 10: 回归 — 链接拦截不误伤编辑器"
open_page "/vault/notes/main.md"
agent-browser eval "(() => { window.__litemd__cm.view.focus(); return 1; })()" > /dev/null 2>&1
agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: v.state.doc.length, to: v.state.doc.length, insert: 'XY'}}); return 1; })()" > /dev/null 2>&1
sleep 0.8
DOC_TAIL=$(evs "window.__litemd__cm.view.state.doc.sliceString(Math.max(0, window.__litemd__cm.view.state.doc.length - 2))")
[[ "$DOC_TAIL" == "XY" ]] && ok "编辑器输入正常" || fail "编辑器输入异常: $DOC_TAIL"
DIRTY=$(evs "window.__litemd__tm.active?.dirty")
[[ "$DIRTY" == "true" ]] && ok "脏标记正常置位" || fail "脏标记异常: $DIRTY"

# ============================================================================
echo
echo "════════════════════════════════════"
echo "  Sprint 9 结果: $PASS 通过 / $FAIL 失败"
echo "════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
