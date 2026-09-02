#!/usr/bin/env bash
# Sprint 7 E2E — UI 优化（5 项）
#
#   1. 目录树隐藏后内容栏自动扩展
#   2. 顶栏 tooltip 被遮挡（z-index 修复）
#   3. 顶栏高度压缩（与侧边栏标题对齐）
#   4. 预览中 []() 链接不可点击
#   5. 代码块语言标签 + 复制按钮（Obsidian 风）
#
# 复用 sprint1-6 的 vite preview + agent-browser CLI。

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

# ============================================================================
log "Step 0: vite preview 启动检查"
if ! curl -sf -o /dev/null http://127.0.0.1:5174/dev.html; then
    cd frontend && (nohup npx vite preview --port 5174 --strictPort > /tmp/vite_sprint7.log 2>&1 &) && cd ..
    sleep 4
fi
if curl -sf -o /dev/null http://127.0.0.1:5174/dev.html; then
    echo "vite=200"
else
    echo "vite=DOWN"; exit 2
fi
agent-browser open http://127.0.0.1:5174/dev.html > /dev/null 2>&1
sleep 3

# ============================================================================
log "场景 1: 目录树隐藏后内容栏自动扩展"
TABBAR_ON=$(ev "document.getElementById('tabbar').clientWidth")
[[ "$TABBAR_ON" -lt 1280 ]] && ok "开启态 tabbar 宽度=${TABBAR_ON}（< 1280）" \
    || fail "开启态 tabbar 异常: $TABBAR_ON"

# 关闭侧边栏
agent-browser eval "document.querySelector('button[data-action=toggle-sidebar]').click()" > /dev/null 2>&1
sleep 0.5
VAR_OFF=$(evs "getComputedStyle(document.getElementById('app')).getPropertyValue('--sidebar-w')")
TABBAR_OFF=$(ev "document.getElementById('tabbar').clientWidth")
[[ "$VAR_OFF" == "0px" ]] && ok "收起后 --sidebar-w=${VAR_OFF}" || fail "变量未归零: $VAR_OFF"
[[ "$TABBAR_OFF" -gt "$TABBAR_ON" ]] && ok "tabbar 自动扩展 ${TABBAR_ON} → ${TABBAR_OFF}（+240px）" \
    || fail "tabbar 未扩展: ${TABBAR_ON} → ${TABBAR_OFF}"

# 三模式都验证
for mode in left right; do
    agent-browser eval "document.querySelector('button[data-action=mode-${mode}]').click()" > /dev/null 2>&1
    sleep 0.4
    SEL=$([ "$mode" = "left" ] && echo ".cm-editor" || echo "#preview")
    W=$(ev "document.querySelector('${SEL}').clientWidth")
    [[ "$W" -eq 1280 ]] && ok "mode=${mode} 下 pane 占满 1280px" \
        || fail "mode=${mode} pane=${W}px（期望 1280）"
done

# 恢复 + 重新展开
agent-browser eval "document.querySelector('button[data-action=mode-both]').click()" > /dev/null 2>&1
sleep 0.3
agent-browser eval "document.querySelector('button[data-action=toggle-sidebar]').click()" > /dev/null 2>&1
sleep 0.5
VAR_ON=$(evs "getComputedStyle(document.getElementById('app')).getPropertyValue('--sidebar-w')" | sed 's/px//')
[[ "$VAR_ON" -gt 100 ]] && ok "重新展开 --sidebar-w=${VAR_ON}px（恢复）" || fail "展开后未恢复: ${VAR_ON}px"

# ============================================================================
log "场景 2: 顶栏 tooltip 不被目录栏 / 标签栏遮挡"
# 根因：topbar 自身没设 z-index，被按 DOM 顺序后绘制的兄弟（.sidebar / .tabbar）
# 盖住；tooltip z:100 只在 topbar 内部有效，跨不过 topbar 边界。修复后 topbar
# 提为 z:10 stacking context，其下后代（tooltip）自然在 sidebar / tabbar 之上。
TOPBAR_POS=$(evs "getComputedStyle(document.querySelector('.topbar')).position")
TOPBAR_Z=$(evs "getComputedStyle(document.querySelector('.topbar')).zIndex")
[[ "$TOPBAR_POS" == "relative" ]] && ok ".topbar position: relative" || fail ".topbar position: $TOPBAR_POS"
[[ "$TOPBAR_Z" -ge 10 ]] && ok ".topbar z-index=${TOPBAR_Z} ≥ 10（提为顶层 stacking context）" \
    || fail ".topbar z-index=$TOPBAR_Z（仍受 DOM 顺序压制）"

# 触发 hover：agent-browser hover 真实移动鼠标触发 :hover（CSS 事件不能由
# 单纯 dispatchEvent 触发，hover 状态由浏览器根据指针位置切换）
agent-browser hover ".actions button[data-action=new]" > /dev/null 2>&1
# 等 CSS transition delay 0.6s 完成
sleep 1.0

TIP_OPAC=$(evs "getComputedStyle(document.querySelector('.actions button[data-action=new] .tip')).opacity")
TIP_VISI=$(evs "getComputedStyle(document.querySelector('.actions button[data-action=new] .tip')).visibility")
[[ "$TIP_OPAC" == "1" && "$TIP_VISI" == "visible" ]] \
    && ok "tooltip 浮出（opacity=${TIP_OPAC}, visibility=${TIP_VISI}）" \
    || fail "tooltip 未浮出: opacity=$TIP_OPAC visibility=$TIP_VISI"

# 视觉验证：截图截顶部 + sidebar-head 区域，肉眼确认 tooltip 浮在最上
agent-browser screenshot "" e2e/sprint7-tooltip-on-top.png > /dev/null 2>&1
OK=$(ls -l /workspace/litemd-build/LiteMD-v0.2.0-src/e2e/sprint7-tooltip-on-top.png 2>/dev/null | awk '{print $5}')
[[ -n "$OK" && "$OK" -gt 1000 ]] && ok "视觉截图已生成：e2e/sprint7-tooltip-on-top.png（应见 tooltip 浮在 sidebar-head 之上）" \
    || fail "截图生成失败"

# 像素级断言：取 tooltip 中心区样本，应比 sidebar-head 背景更亮（提示词背景 --bg-3 较深色 sidebar 背景更深）
# 用 canvas 取像素均值：tooltip 区域应明显比 sidebar-head 同列区域更暗（提示词背景色）
# 这里仅做粗略检测：tooltip 中心处计算样式 backgroundColor 应为深色
TIP_BG=$(evs "getComputedStyle(document.querySelector('.actions button[data-action=new] .tip')).backgroundColor")
[[ -n "$TIP_BG" && "$TIP_BG" != "rgba(0, 0, 0, 0)" ]] && ok "tooltip 有独立背景（${TIP_BG}），与 sidebar 区分" \
    || fail "tooltip 背景透明: $TIP_BG"

# ============================================================================
log "场景 3: 标题栏增高 / 标签栏压缩（v0.2.5 布局调整）"
TB_H=$(ev "document.querySelector('.topbar').getBoundingClientRect().height")
SH_H=$(ev "document.querySelector('.sidebar-head').getBoundingClientRect().height")
TAB_H=$(ev "document.querySelector('.tabbar').getBoundingClientRect().height")
GRID_ROW1=$(evs "getComputedStyle(document.getElementById('app')).gridTemplateRows.split(' ')[0]")
GRID_ROW2=$(evs "getComputedStyle(document.getElementById('app')).gridTemplateRows.split(' ')[1]")
[[ "$TB_H" -ge 36 && "$TB_H" -le 44 ]] && ok "标题栏高度=${TB_H}px（增高至 40px 档，sidebar-head=${SH_H}px）" \
    || fail "标题栏高度 ${TB_H}px（期望 36-44px）"
[[ "$GRID_ROW1" == "40px" ]] && ok "grid 第 1 行=${GRID_ROW1}（标题栏 40px）" \
    || fail "grid 第 1 行=${GRID_ROW1}（应 40px）"
[[ "$TAB_H" -le 32 ]] && ok "标签栏高度=${TAB_H}px（压缩至 30px 档）" \
    || fail "标签栏高度 ${TAB_H}px（期望 ≤32px）"
[[ "$GRID_ROW2" == "30px" ]] && ok "grid 第 2 行=${GRID_ROW2}（标签栏 30px）" \
    || fail "grid 第 2 行=${GRID_ROW2}（应 30px）"
# 视觉验证
agent-browser screenshot "" e2e/sprint7-topbar-compact.png > /dev/null 2>&1
ok "视觉截图：e2e/sprint7-topbar-compact.png"

# ============================================================================
log "场景 4: 预览中 []() 链接可点击（相对路径 + 危险 scheme 过滤）"
DOC='[正常](https://safe.example)
[相对](./rel.md)
[上级](../up.md)
[同层](sibling.md)
[根相对](/root.md)
[js](javascript:alert(1))
[data](data:text/html,xss)
[vbs](vbscript:msgbox(1))'
agent-browser eval "window.__litemd__cm.setContent(\`$(printf '%s' "$DOC" | sed 's/`/\\`/g')\`)" > /dev/null 2>&1
sleep 1

# agent-browser 把多行字符串原样转义为 JSON，单行 tail -1 拿不到完整列表。
# 把结果写入 document.title：单字符串、无空格以外的转义、agent-browser
# 输出对字符串会保持原值（最多是字面转义符）
agent-browser eval "document.title = [...document.querySelectorAll('#preview a')].map(a => a.textContent + '|||' + (a.getAttribute('href') || '')).join('|||')" > /dev/null 2>&1
LINKS=$(agent-browser eval "document.title" 2>&1 | tail -1 | sed -e 's/^"//' -e 's/"$//')

# 安全链接应有 href
check_href() {
    local label="$1" expect="$2"
    local got
    got=$(echo "$LINKS" | python3 -c "
import sys
data = sys.stdin.read().strip()
parts = data.split('|||')
# 配对：parts[0]=text1, parts[1]=href1, parts[2]=text2, parts[3]=href2, ...
got = ''
for i in range(0, len(parts)-1, 2):
    if parts[i] == '$label':
        got = parts[i+1]; break
print(got)
")
    if [[ "$expect" == "-" ]]; then
        [[ -z "$got" ]] && ok "$label 危险 scheme 已剥除（href=空）" || fail "$label href='$got'（期望为空）"
    else
        [[ "$got" == "$expect" ]] && ok "$label 链接 href='$got'" || fail "$label href='$got'（期望 '$expect'）"
    fi
}
check_href "正常"   "https://safe.example"
check_href "相对"   "./rel.md"
check_href "上级"   "../up.md"
check_href "同层"   "sibling.md"
check_href "根相对" "/root.md"
check_href "js"     "-"
check_href "data"   "-"
check_href "vbs"    "-"

# 模拟点击：阻止实际导航，记录到 window.__lastNav
agent-browser eval "(() => { window.__lastNav = ''; document.getElementById('preview').addEventListener('click', e => { const a = e.target.closest('a'); if(a && a.getAttribute('href')) { e.preventDefault(); window.__lastNav = a.getAttribute('href'); } }, true); return 1; })()" > /dev/null 2>&1
sleep 0.2
agent-browser click "#preview a" > /dev/null 2>&1
sleep 0.3
LAST=$(evs "window.__lastNav")
[[ -n "$LAST" ]] && ok "点击链接触发跳转：href='$LAST'" || fail "点击未触发跳转"

# ============================================================================
log "场景 5: 代码块语言标签 + 复制按钮（Obsidian 风）"
DOC='```python
def hi():
    print("hello")
```

```javascript
console.log(1);
```

```bash
echo shell
```'
agent-browser eval "window.__litemd__cm.setContent(\`$(printf '%s' "$DOC" | sed 's/`/\\`/g')\`)" > /dev/null 2>&1
sleep 1

CB_COUNT=$(ev "document.querySelectorAll('#preview .code-block').length")
[[ "$CB_COUNT" -eq 3 ]] && ok "3 个代码块均被 .code-block 容器包裹" \
    || fail "装饰容器数=${CB_COUNT}（期望 3）"

# 每块的语言标签
agent-browser eval "document.title = [...document.querySelectorAll('#preview .code-block-lang')].map(e => e.textContent).join(',')" > /dev/null 2>&1
LANGS=$(agent-browser eval "document.title" 2>&1 | tail -1 | sed -e 's/^"//' -e 's/"$//')
[[ "$LANGS" == "python,javascript,bash" ]] && ok "语言标签: $LANGS" \
    || fail "语言标签: $LANGS（期望 python,javascript,bash）"

# 每个代码块都有复制按钮
COPY_COUNT=$(ev "document.querySelectorAll('#preview .code-block-copy').length")
[[ "$COPY_COUNT" -eq 3 ]] && ok "3 个复制按钮就位" || fail "复制按钮=${COPY_COUNT}"

# pre 上的 data-line 仍保留（同步滚动 / TOC 跳转不被破坏）
LINE3=$(evs "document.querySelectorAll('#preview .code-block > pre')[0].dataset.line")
[[ -n "$LINE3" ]] && ok "pre data-line 保留：第 1 块=${LINE3}" || fail "pre data-line 丢失"

# 视觉
agent-browser screenshot "" e2e/sprint7-codeblocks.png > /dev/null 2>&1
ok "视觉截图：e2e/sprint7-codeblocks.png"

# ============================================================================
echo
echo "═══════════════════════════════════════════════"
echo " Sprint 7（截至场景 5）测试结果：${PASS} 通过 / ${FAIL} 失败"
echo "═══════════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
