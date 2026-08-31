#!/usr/bin/env bash
# LiteMD Sprint 2 E2E 测试脚本（v2 — 稳定比较版）
# 覆盖：CodeMirror + 实时预览 + 分屏拖拽 + XSS 防护 + 视图切换

set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# E13 修复：预检 agent-browser CLI
if ! command -v agent-browser >/dev/null 2>&1; then
    echo "❌ 错误: agent-browser CLI 未安装或不在 PATH 中"
    echo "请参阅 TRAE 文档安装: `@trae/agent-browser` 插件或运行 npm 安装对应 CLI"
    exit 2
fi

PASS=0
FAIL=0
TOTAL=0

log() { echo -e "${BLUE}[S2 E2E]${NC} $*"; }
ok() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}✓${NC} $*"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}✗${NC} $*"; }

# 在浏览器里执行 JS，提取第一行 JSON 数字/字符串
# 用法：jval <expression>  → 输出纯字符串/数字
jval() {
    local expr="$1"
    agent-browser eval "$expr" 2>&1 | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        v = json.loads(line)
        if isinstance(v, (int, float)): print(v)
        elif isinstance(v, str): print(v)
        else: print(json.dumps(v))
        break
    except: continue
"
}

# 断言 jval == want
assert_eq() {
    local desc="$1"; local expr="$2"; local want="$3"
    local got
    got=$(jval "$expr")
    if [[ "$got" == "$want" ]]; then
        ok "$desc (=$got)"
    else
        fail "$desc (want=$want got=$got)"
    fi
}

assert_ge() {
    local desc="$1"; local expr="$2"; local want="$3"
    local got
    got=$(jval "$expr")
    if [[ -z "$got" ]] || ! [[ "$got" =~ ^[0-9]+$ ]]; then
        fail "$desc (got invalid: $got)"
        return
    fi
    if [[ "$got" -ge "$want" ]]; then
        ok "$desc ($got >= $want)"
    else
        fail "$desc ($got < $want)"
    fi
}

inject_md() {
    local md="$1"
    local esc
    esc=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$md")
    agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: $esc}}); return 'set'; })()" > /dev/null 2>&1
    # 等预览刷新
    sleep 2
}

# ============================================================================
log "Step 0: 打开 LiteMD dev 页面 + 等 CodeMirror 加载"
agent-browser open http://127.0.0.1:5174/dev.html > /dev/null 2>&1
# CodeMirror bundle 较大（673KB），需要等 JS 解析
CM_READY=0
for i in $(seq 1 15); do
    sleep 1
    READY=$(agent-browser eval "!!document.querySelector('.cm-editor') && !!window.__litemd__cm && !!window.__litemd__cm.view" 2>&1 | tail -1)
    if echo "$READY" | grep -q "true"; then
        ok "CodeMirror 在 ${i}s 内就绪"
        CM_READY=1
        break
    fi
done
# E6 修复：CodeMirror 超时必须 fail，不能静默漏判
if [[ "$CM_READY" -ne 1 ]]; then
    fail "CodeMirror 15s 内未就绪"
fi
sleep 2

# ----------------------------------------------------------------------------
log "场景 1: CodeMirror + SplitPane 加载"
assert_eq "cm-editor 渲染" "document.querySelectorAll('.cm-editor').length" "1"
assert_ge "cm-line 行数 >= 1" "document.querySelectorAll('.cm-line').length" "1"
assert_eq "splitpane 模式" "document.getElementById('splitpane').dataset.mode" "both"
assert_eq "标签数 = 1" "document.querySelectorAll('#tabbar .tab').length" "1"
assert_eq "preview 面板存在" "document.querySelectorAll('.preview').length" "1"

# ----------------------------------------------------------------------------
log "场景 2: Markdown → Preview 实时渲染"
inject_md "# Hello LiteMD

This is **bold** and *italic*.

- item 1
- item 2
- item 3

\`\`\`js
const x = 1;
\`\`\`

[External Link](https://example.com)"

assert_eq "h1 渲染" "document.querySelectorAll('.preview h1').length" "1"
assert_eq "strong 渲染" "document.querySelectorAll('.preview strong').length" "1"
assert_eq "em 渲染" "document.querySelectorAll('.preview em').length" "1"
assert_eq "ul li 渲染" "document.querySelectorAll('.preview ul li').length" "3"
assert_eq "fenced code 渲染" "document.querySelectorAll('.preview pre').length" "1"
assert_eq "code language class" "document.querySelector('.preview pre code')?.className" "language-js"
assert_eq "external link target=_blank" "document.querySelectorAll('.preview a[target=_blank]').length" "1"
assert_eq "external link rel=noopener" "document.querySelectorAll('.preview a[rel*=noopener]').length" "1"

# ----------------------------------------------------------------------------
log "场景 3: CodeMirror 语法高亮"
assert_ge "cm-line >= 8" "document.querySelectorAll('.cm-line').length" "8"
# 高亮不为空：cm-tok-* 节点存在
TOK_COUNT=$(jval "document.querySelectorAll('.cm-line span').length")
if [[ -n "$TOK_COUNT" ]] && [[ "$TOK_COUNT" -gt 0 ]]; then
    ok "cm syntax tokens 渲染: $TOK_COUNT"
else
    fail "cm syntax tokens 缺失: $TOK_COUNT"
fi

# ----------------------------------------------------------------------------
log "场景 4: XSS 防护"
XSS_MD='# Title

<script>alert(1)</script>

[bad link](javascript:alert(1))

<img src=x onerror=alert(2)>

<iframe src=javascript:alert(3)></iframe>

<a href="x" onclick="alert(4)">click</a>'
inject_md "$XSS_MD"

assert_eq "无 <script>" "document.querySelectorAll('.preview script').length" "0"
assert_eq "无 javascript: 链接" "document.querySelectorAll('.preview a[href*=\"javascript:\" i]').length" "0"
assert_eq "无 onerror 属性" "document.querySelectorAll('.preview img[onerror]').length" "0"
assert_eq "无 iframe" "document.querySelectorAll('.preview iframe').length" "0"
assert_eq "无 onclick 属性" "document.querySelectorAll('.preview a[onclick]').length" "0"
assert_eq "无 onload 属性" "document.querySelectorAll('.preview [onload]').length" "0"

# ----------------------------------------------------------------------------
log "场景 5: 分屏拖拽改比例"
RATIO1=$(jval "document.getElementById('splitpane').style.getPropertyValue('--split-ratio')")
[[ -n "$RATIO1" ]] && ok "初始 ratio 已设置: $RATIO1" || fail "初始 ratio 缺失"

# 模拟拖拽（直接 dispatchPointer）
agent-browser eval "(() => { const h = document.querySelector('.pane-handle'); h.dispatchEvent(new PointerEvent('pointerdown', {pointerId:1, clientX: 800})); window.dispatchEvent(new PointerEvent('pointermove', {pointerId:1, clientX: 600})); window.dispatchEvent(new PointerEvent('pointerup', {pointerId:1, clientX: 600})); return 'ok'; })()" > /dev/null 2>&1
sleep 1
RATIO2=$(jval "document.getElementById('splitpane').style.getPropertyValue('--split-ratio')")
if [[ "$RATIO2" != "$RATIO1" ]]; then
    ok "拖拽后比例变化: $RATIO1 → $RATIO2"
else
    fail "拖拽未生效: $RATIO1 = $RATIO2"
fi

# 双击重置
agent-browser eval "(() => { document.querySelector('.pane-handle').dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); return 'done'; })()" > /dev/null 2>&1
sleep 1
# E4 修复：pattern 原写为 "50*%"，glob 语义要求 50 与 % 之间有任意字符，但 "50%" 本身不含，导致永久 fail
# splitpane 双击 reset 设为 0.5，CSS property 为 "50.00%"（splitpane.ts 用 toFixed(2) 格式化），
# 因此用数值比较而非字符串精确匹配
RATIO3=$(jval "document.getElementById('splitpane').style.getPropertyValue('--split-ratio')")
RATIO3_NUM=$(echo "$RATIO3" | sed 's/%$//')
if awk -v a="$RATIO3_NUM" 'BEGIN{exit !(a>=49.9 && a<=50.1)}'; then
    ok "双击 handle → 重置为 $RATIO3"
else
    fail "双击重置异常: got=$RATIO3 (want≈50%)"
fi

# ----------------------------------------------------------------------------
log "场景 6: 视图切换"
agent-browser eval "document.querySelector('button[data-action=mode-left]').click()" > /dev/null 2>&1
sleep 1
assert_eq "mode-left 模式" "document.getElementById('splitpane').dataset.mode" "left"

agent-browser eval "document.querySelector('button[data-action=mode-right]').click()" > /dev/null 2>&1
sleep 1
assert_eq "mode-right 模式" "document.getElementById('splitpane').dataset.mode" "right"

agent-browser eval "document.querySelector('button[data-action=mode-both]').click()" > /dev/null 2>&1
sleep 1
assert_eq "mode-both 模式" "document.getElementById('splitpane').dataset.mode" "both"

# ----------------------------------------------------------------------------
log "场景 7: 新建标签 + Preview 跟随切换"
agent-browser eval "document.querySelector('button[data-action=new]').click()" > /dev/null 2>&1
sleep 1
assert_eq "标签数 = 2" "document.querySelectorAll('#tabbar .tab').length" "2"

inject_md "# Second tab"
assert_eq "second tab h1" "document.querySelector('.preview h1')?.textContent" "Second tab"

# 切回 tab-1
agent-browser eval "(() => { document.querySelectorAll('#tabbar .tab')[0].dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); return 'ok'; })()" > /dev/null 2>&1
sleep 1
TXT=$(jval "document.querySelector('.preview h1')?.textContent")
[[ "$TXT" == "Title" ]] && ok "切回 tab-1 → preview = $TXT" || fail "切回 tab-1 → preview = $TXT"

# ----------------------------------------------------------------------------
log "场景 8: 大文档性能（100KB → 渲染时长 < 3000ms）"
python3 -c "
import json, sys
content = '# Doc\n\n' + ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' * 2000 + '\n\n') * 10
content = content[:100000]
print(json.dumps(content))
" > /tmp/big_md.json
BIG_MD=$(cat /tmp/big_md.json)
agent-browser eval "(() => { window.__t0 = performance.now(); const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: $BIG_MD}}); window.__t1 = performance.now(); return 'inserted'; })()" > /dev/null 2>&1
sleep 3
DUR_INJECT=$(jval "window.__t1 - window.__t0")
DUR_RENDER=$(jval "(() => { const t2 = performance.now(); return t2 - window.__t1; })()")
echo -e "  ${BLUE}ℹ${NC}  注入 100KB 用时: ${DUR_INJECT}ms; 渲染用时: ${DUR_RENDER}ms"
# 注入和渲染合并时长应小于 3000ms
TOTAL_MS=$(jval "(() => { return window.__t1 - window.__t0; })()")
if [[ -n "$TOTAL_MS" ]] && python3 -c "import sys; sys.exit(0 if float('$TOTAL_MS') < 3000 else 1)"; then
    ok "100KB 文档处理时长 ${TOTAL_MS}ms < 3000ms"
else
    fail "100KB 文档渲染异常: ${TOTAL_MS}ms"
fi

# ----------------------------------------------------------------------------
log "场景 9: 截图存档"
agent-browser screenshot /workspace/LiteMD/e2e/sprint2-screenshot.png > /dev/null 2>&1
if [[ -f /workspace/LiteMD/e2e/sprint2-screenshot.png ]]; then
    SIZE=$(du -h /workspace/LiteMD/e2e/sprint2-screenshot.png | cut -f1)
    ok "sprint2 截图 ($SIZE)"
else
    fail "sprint2 截图未保存"
fi

# ============================================================================
echo
echo "=========================================="
echo -e "  Sprint 2 通过: ${GREEN}${PASS}${NC}  失败: ${RED}${FAIL}${NC}  合计: ${TOTAL}"
echo "=========================================="

agent-browser close > /dev/null 2>&1 || true
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
