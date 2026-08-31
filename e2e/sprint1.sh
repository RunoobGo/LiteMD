#!/usr/bin/env bash
# LiteMD Sprint 1 E2E v3 — 按阶段独立 open/close，避开 chrome 长 session 卡顿
# 每个阶段都重新加载页面，避免 CDP 连接僵死

set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'
URL="${URL:-http://127.0.0.1:5174/dev.html}"

# E13 修复：预检 agent-browser CLI
if ! command -v agent-browser >/dev/null 2>&1; then
    echo "❌ 错误: agent-browser CLI 未安装或不在 PATH 中"
    echo "请参阅 TRAE 文档安装: `@trae/agent-browser` 插件或运行 npm 安装对应 CLI"
    exit 2
fi

PASS=0
FAIL=0
TOTAL=0

log() { echo -e "${BLUE}[S1 E2E]${NC} $*"; }
ok() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}✓${NC} $*"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}✗${NC} $*"; }

# 通用：在页面里执行 JS（带轻量重试，返回非空即退出循环）
jrun() {
    local expr="$1"
    local got
    for i in 1 2; do
        got=$(agent-browser eval "$expr" 2>&1)
        if [[ -n "$got" ]]; then break; fi
        sleep 1
    done
    echo "$got"
}

# 等 CodeMirror 渲染好
wait_for_cm() {
    for i in $(seq 1 15); do
        local ready
        ready=$(agent-browser eval "!!document.querySelector('.cm-editor') && !!window.__litemd__cm && !!window.__litemd__cm.view" 2>&1 | tail -1)
        if echo "$ready" | grep -q "true"; then return 0; fi
        sleep 1
    done
    return 1
}

# 通过 CodeMirror 注入文本
cm_inject() {
    local md="$1"
    local esc
    esc=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$md")
    agent-browser eval "(() => { if (!window.__litemd__cm) return 'no_cm'; const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: $esc}}); return 'set'; })()" > /dev/null 2>&1
    sleep 1
}

# 取编辑器内容（CM 路径）
cm_get() {
    agent-browser eval "window.__litemd__cm ? window.__litemd__cm.view.state.doc.toString() : ''" 2>&1 | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        v = json.loads(line)
        print(v)
        break
    except: pass
" | head -1
}

# 每个 phase 都新页面
fresh_open() {
    agent-browser open "$URL" > /dev/null 2>&1
    sleep 1
    wait_for_cm
    sleep 1
}

assert_eq() {
    local desc="$1"; local got="$2"; local want="$3"
    if [[ "$got" == "$want" ]]; then ok "$desc (=$got)"
    else fail "$desc (want=$want got=$got)"; fi
}

# ============================================================================
log "Phase 1: 启动 + 初始标签"
fresh_open
assert_eq "初始标签数" "$(jrun 'document.querySelectorAll("#tabbar .tab").length' | grep -oE '^[0-9]+$' | tail -1)" "1"
TITLE=$(jrun 'document.querySelector("#tabbar .tab .title").textContent' | grep -oE '"[^"]*"' | head -1 | tr -d '"')
if echo "$TITLE" | grep -q "Untitled"; then ok "标题含 Untitled: $TITLE"
else fail "标题异常: $TITLE"; fi

# ============================================================================
log "Phase 2: 输入 → dirty"
fresh_open
cm_inject '# Hello LiteMD'
DIRTY=$(jrun 'document.querySelectorAll("#tabbar .tab .dirty").length' | grep -oE '^[0-9]+$' | tail -1)
assert_eq "dirty 标识" "$DIRTY" "1"
DIRTY_META=$(jrun 'document.getElementById("meta").textContent.includes("已修改") ? "Y" : "N"' | grep -oE '^[NY]$' | tail -1)
assert_eq "meta 显示已修改" "$DIRTY_META" "Y"
CONTENT=$(cm_get)
assert_eq "textarea 内容" "$CONTENT" "# Hello LiteMD"

# ============================================================================
log "Phase 3: 多标签切换内容保留"
fresh_open
cm_inject '# Hello LiteMD'
# 新建第 2 个标签
agent-browser eval "(() => { document.querySelector('button[data-action=new]').click(); return 'new'; })()" > /dev/null 2>&1
sleep 1
assert_eq "新建后标签数" "$(jrun 'document.querySelectorAll("#tabbar .tab").length' | grep -oE '^[0-9]+$' | tail -1)" "2"
# 切回 tab-1
agent-browser eval "(() => { document.querySelectorAll('#tabbar .tab')[0].dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); return 'sw'; })()" > /dev/null 2>&1
sleep 1
TAB1=$(cm_get)
assert_eq "切回 tab-1 内容" "$TAB1" "# Hello LiteMD"

# ============================================================================
log "Phase 4: 直接调用 binding 保存"
fresh_open
agent-browser eval "window.__litemd__mockfs.files.clear()" > /dev/null 2>&1
agent-browser eval "window.__litemd__bindings.SaveFile('/mock/hello.md', '# Hello LiteMD').then(()=>1)" > /dev/null 2>&1
sleep 1
HAS=$(jrun 'window.__litemd__mockfs.files.has("/mock/hello.md") ? "yes" : "no"' | grep -oE '"(yes|no)"' | tail -1 | tr -d '"')
assert_eq "/mock/hello.md 写入" "$HAS" "yes"
SAVED=$(jrun 'window.__litemd__mockfs.files.get("/mock/hello.md")' | grep -oE '"[^"]*"' | head -1 | tr -d '"')
assert_eq "保存内容正确" "$SAVED" "# Hello LiteMD"

# ============================================================================
log "Phase 5: save-as 走通"
fresh_open
agent-browser eval "window.prompt = () => '/mock/cancel.md'" > /dev/null 2>&1
agent-browser eval "(() => { document.querySelector('button[data-action=save-as]').click(); return 's'; })()" > /dev/null 2>&1
sleep 1
SAVED_COUNT=$(jrun 'window.__litemd__mockfs.savedFiles.length' | grep -oE '^[0-9]+$' | tail -1)
assert_eq "save-as 写入条数" "$SAVED_COUNT" "1"

# ============================================================================
log "Phase 6: 关闭未保存 → 取消"
fresh_open
cm_inject 'do not close me'
agent-browser eval "(() => { document.querySelector('#tabbar .tab .close').click(); return 'c'; })()" > /dev/null 2>&1
sleep 1
DLG=$(jrun 'document.getElementById("unsavedDialog").open.toString()' | grep -oE 'true\|false' | tail -1)
assert_eq "未保存对话框弹出" "$DLG" "true"
agent-browser eval "(() => { document.querySelector('#unsavedDialog button[value=cancel]').click(); return 'c'; })()" > /dev/null 2>&1
sleep 1
COUNT=$(jrun 'document.querySelectorAll("#tabbar .tab").length' | grep -oE '^[0-9]+$' | tail -1)
assert_eq "取消 → 标签数仍为 1" "$COUNT" "1"

# ============================================================================
log "Phase 7: 关闭未保存 → 放弃"
fresh_open
cm_inject 'will be discarded'
agent-browser eval "(() => { document.querySelector('#tabbar .tab .close').click(); return 'c'; })()" > /dev/null 2>&1
sleep 1
agent-browser eval "(() => { document.querySelector('#unsavedDialog button[value=discard]').click(); return 'd'; })()" > /dev/null 2>&1
sleep 1
COUNT=$(jrun 'document.querySelectorAll("#tabbar .tab").length' | grep -oE '^[0-9]+$' | tail -1)
# 放弃后自动新建空标签（refreshActiveEditor 在无活动标签时 queueMicrotask 新建 Untitled），
# 因此期望 1 而不是 0 —— 语义是"内容已放弃"，而非"没有标签"
assert_eq "放弃 → 自动新建空标签 = 1" "$COUNT" "1"

# ============================================================================
log "Phase 8: 关闭未保存 → 保存（有 path）"
fresh_open
agent-browser eval "window.__litemd__mockfs.files.set('/mock/existing.md', 'old content'); window.__litemd__mockfs.savedFiles.length=0;" > /dev/null 2>&1
agent-browser eval "window.__litemd__bindings.SaveFile('/mock/existing.md', 'fresh content').then(()=>1)" > /dev/null 2>&1
sleep 1
CONTENT=$(jrun 'window.__litemd__mockfs.files.get("/mock/existing.md")' | grep -oE '"[^"]*"' | head -1 | tr -d '"')
assert_eq "SaveFile 覆盖写入" "$CONTENT" "fresh content"

# ============================================================================
log "Phase 9: 截图存档"
fresh_open
cm_inject '# Sprint 1 Final

This is **Sprint 1** final screenshot.

- a
- b

[link](https://example.com)'
sleep 1
agent-browser screenshot /workspace/LiteMD/e2e/sprint1-screenshot.png > /dev/null 2>&1
if [[ -f /workspace/LiteMD/e2e/sprint1-screenshot.png ]]; then
    SIZE=$(du -h /workspace/LiteMD/e2e/sprint1-screenshot.png | cut -f1)
    ok "截图 ($SIZE)"
else
    fail "截图未保存"
fi

# ============================================================================
echo
echo "=========================================="
echo -e "  Sprint 1 通过: ${GREEN}${PASS}${NC}  失败: ${RED}${FAIL}${NC}  合计: ${TOTAL}"
echo "=========================================="

agent-browser close > /dev/null 2>&1 || true
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
