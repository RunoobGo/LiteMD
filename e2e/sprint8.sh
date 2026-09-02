#!/usr/bin/env bash
# Sprint 8 E2E — 代码审查修复回归（🔴/🟡 关键项）
#
#   1. 🔴-1 复制按钮监听器不随渲染累积
#   2. 🔴-2 对话框 returnValue 在 showModal 前重置（ESC 不再残留上次选择）
#   3. 🔴-3 标签栏键盘导航（roving tabindex + 方向键）
#   4. 🟡-9 TOC 键盘导航（↑/↓ 移动）
#   5. 🟡-8 分屏把手键盘调整（→ 步进）
#   6. 🟡-2 图片插入到光标处（insertAtCursor）
#   7. 🟡-2 tab 光标位置记忆（切回恢复）
#   8. 🟡-1 mock CopyImageAsset 拒绝非绝对路径（对齐 Go 侧 safeWritePath）
#
# 复用 sprint1-7 的 vite preview + agent-browser CLI。

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

# 打开页面并等编辑器就绪
fresh() {
    agent-browser open http://127.0.0.1:5174/dev.html > /dev/null 2>&1
    sleep 2
    agent-browser eval "window.__litemd__cm && window.__litemd__tm ? 1 : 0" > /dev/null 2>&1
    sleep 1
}

# 注入 markdown 内容（走编辑器 dispatch，触发完整 onChange 链路）
set_doc() {
    agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: $1}}); return 1; })()" > /dev/null 2>&1
    sleep 0.8
}

# ============================================================================
log "Step 0: vite preview 启动检查"
if ! curl -sf -o /dev/null http://127.0.0.1:5174/dev.html; then
    cd frontend && (nohup npx vite preview --port 5174 --strictPort > /tmp/vite_sprint8.log 2>&1 &) && cd ..
    sleep 4
fi
curl -sf -o /dev/null http://127.0.0.1:5174/dev.html && echo "vite=200" || { echo "vite=DOWN"; exit 2; }

# ============================================================================
log "场景 1: 复制按钮监听器不累积（🔴-1）"
fresh
# 用 5 次不同内容触发 5 次 render（旧版每次 render 都追加一个 click 监听器）
agent-browser eval "(() => { window.__clipCalls = 0; const c = navigator.clipboard; if (c && c.writeText) { const orig = c.writeText.bind(c); c.writeText = (t) => { window.__clipCalls += 1; return orig(t); }; } return navigator.clipboard ? 1 : 0; })()" > /dev/null 2>&1
for i in 1 2 3 4 5; do
    agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: '\`\`\`js\nvar x = $i;\n\`\`\`'}}); return 1; })()" > /dev/null 2>&1
    sleep 0.5
done
CB=$(ev "document.querySelectorAll('#preview .code-block-copy').length")
[[ "$CB" -ge 1 ]] && ok "复制按钮存在（${CB} 个）" || fail "复制按钮不存在"
agent-browser click "#preview .code-block-copy" > /dev/null 2>&1
sleep 0.5
CALLS=$(ev "window.__clipCalls")
[[ "$CALLS" -eq 1 ]] && ok "点击一次复制 → clipboard 写入 ${CALLS} 次（无监听器累积）" \
    || fail "clipboard 写入 ${CALLS} 次（期望 1，监听器已累积）"

# ============================================================================
log "场景 2: 对话框 returnValue 重置（🔴-2）"
fresh
set_doc '"dirty content"'
# 模拟上次残留：直接污染 returnValue，再触发关闭 → askUnsaved 应在 showModal 前清空
agent-browser eval "document.getElementById('unsavedDialog').returnValue = 'discard'; 1" > /dev/null 2>&1
agent-browser eval "document.querySelector('#tabbar .tab .close').click(); 1" > /dev/null 2>&1
sleep 0.6
RV=$(evs "document.getElementById('unsavedDialog').returnValue")
[[ "$RV" == "" ]] && ok "showModal 前 returnValue 已重置（残留 'discard' 被清空）" \
    || fail "returnValue='$RV'（残留未清空，ESC 会误执行上次选择）"
# 清理：取消关闭，恢复现场
agent-browser eval "document.querySelector('#unsavedDialog button[value=cancel]').click(); 1" > /dev/null 2>&1
sleep 0.4

# ============================================================================
log "场景 3: 标签栏键盘导航（🔴-3）"
fresh
agent-browser eval "document.querySelector('button[data-action=new]').click(); 1" > /dev/null 2>&1
sleep 0.5
agent-browser eval "document.querySelector('button[data-action=new]').click(); 1" > /dev/null 2>&1
sleep 0.5
TABCNT=$(ev "document.querySelectorAll('#tabbar .tab').length")
[[ "$TABCNT" -eq 3 ]] && ok "3 个标签就位" || fail "标签数=${TABCNT}"
# roving tabindex：仅活动标签 tabindex=0
ROVING=$(ev "(() => { const ts=[...document.querySelectorAll('#tabbar .tab')]; return ts.filter(t=>t.tabIndex===0).length; })()")
[[ "$ROVING" -eq 1 ]] && ok "roving tabindex：仅 1 个标签 tabIndex=0" || fail "tabIndex=0 的标签数=${ROVING}"
# 焦点到第一个标签，按 ArrowRight 应切到第二个
agent-browser eval "document.querySelectorAll('#tabbar .tab')[0].focus(); 1" > /dev/null 2>&1
ACTIVE0=$(evs "window.__litemd__tm.activeId")
agent-browser eval "(() => { const el = document.querySelectorAll('#tabbar .tab')[0]; el.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true})); return 1; })()" > /dev/null 2>&1
sleep 0.5
ACTIVE1=$(evs "window.__litemd__tm.activeId")
[[ "$ACTIVE1" != "$ACTIVE0" ]] && ok "ArrowRight 切换激活标签（${ACTIVE0} → ${ACTIVE1}）" \
    || fail "ArrowRight 未切换激活标签（仍 ${ACTIVE1}）"
# 焦点应已移到新标签（roving 跟随）
FOCUSED=$(ev "document.activeElement === document.querySelectorAll('#tabbar .tab')[1] ? 1 : 0")
[[ "$FOCUSED" -eq 1 ]] && ok "焦点跟随到新激活标签" || fail "焦点未跟随（document.activeElement 非新标签）"

# ============================================================================
log "场景 4: TOC 键盘导航（🟡-9）"
fresh
set_doc '"# 标题一\n\n## 标题二\n\n### 标题三\n\n# 标题四"'
TOCROWS=$(ev "document.querySelectorAll('.toc-row').length")
[[ "$TOCROWS" -eq 4 ]] && ok "4 个 TOC 行就位" || fail "TOC 行数=${TOCROWS}"
agent-browser eval "document.querySelector('.toc-row').focus(); 1" > /dev/null 2>&1
agent-browser eval "(() => { const el = document.querySelector('.toc-row'); el.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true})); return 1; })()" > /dev/null 2>&1
sleep 0.4
FOC2=$(ev "document.activeElement === document.querySelectorAll('.toc-row')[1] ? 1 : 0")
[[ "$FOC2" -eq 1 ]] && ok "ArrowDown 焦点移到第 2 个 TOC 行" || fail "焦点未移动"

# ============================================================================
log "场景 5: 分屏把手键盘调整（🟡-8）"
fresh
RATIO0=$(evs "getComputedStyle(document.getElementById('splitpane')).getPropertyValue('--split-ratio')" | sed 's/%//')
agent-browser eval "document.querySelector('.pane-handle').focus(); 1" > /dev/null 2>&1
agent-browser eval "(() => { const el = document.querySelector('.pane-handle'); el.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true})); return 1; })()" > /dev/null 2>&1
sleep 0.4
RATIO1=$(evs "getComputedStyle(document.getElementById('splitpane')).getPropertyValue('--split-ratio')" | sed 's/%//')
R0=$(python3 -c "print(round(float('$RATIO0')))")
R1=$(python3 -c "print(round(float('$RATIO1')))")
[[ "$R1" -gt "$R0" ]] && ok "ArrowRight 增大比例 ${R0}% → ${R1}%" \
    || fail "比例未变化（${R0}% → ${R1}%）"
ARIA_NOW=$(evs "document.querySelector('.pane-handle').getAttribute('aria-valuenow')")
[[ -n "$ARIA_NOW" ]] && ok "aria-valuenow 同步（${ARIA_NOW}）" || fail "aria-valuenow 缺失"

# ============================================================================
log "场景 6: 图片插入到光标处（🟡-2）"
fresh
set_doc '"前文\n\n后文"'
# 光标定位到第 2 行（"后文"行首）
agent-browser eval "window.__litemd__cm.setCursorPos(2, 1); 1" > /dev/null 2>&1
agent-browser eval "window.__litemd__cm.insertAtCursor('![x](/mock/a.png)\\n'); 1" > /dev/null 2>&1
sleep 0.3
DOC=$(agent-browser eval "window.__litemd__cm.view.state.doc.toString()" 2>&1 | tail -1)
if echo "$DOC" | grep -q '前文'; then
    # 断言插入位置：图片 markdown 应出现在「后文」之前（即第 2 行，而非文档末尾）
    FIRST_LINE_IS_IMG=$(agent-browser eval "window.__litemd__cm.view.state.doc.toString().split('\n')[1].includes('![x]') ? 1 : 0" 2>&1 | tail -1)
    [[ "$FIRST_LINE_IS_IMG" -eq 1 ]] && ok "图片插入到光标处（第 2 行，而非文档末尾）" \
        || fail "图片未插入到光标处"
else
    fail "文档内容异常"
fi

# ============================================================================
log "场景 7: tab 光标位置记忆（🟡-2）"
fresh
set_doc '"line one\nline two\nline three\nline four"'
# 光标定位到第 3 行
agent-browser eval "window.__litemd__cm.setCursorPos(3, 1); 1" > /dev/null 2>&1
# 新建标签（切走）
agent-browser eval "document.querySelector('button[data-action=new]').click(); 1" > /dev/null 2>&1
sleep 0.5
# 切回第一个标签
agent-browser eval "document.querySelectorAll('#tabbar .tab')[0].dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); 1" > /dev/null 2>&1
sleep 0.6
CURLINE=$(ev "window.__litemd__cm.getCursorPos().line")
[[ "$CURLINE" -eq 3 ]] && ok "切回后光标恢复到第 ${CURLINE} 行（记忆生效）" \
    || fail "切回后光标在第 ${CURLINE} 行（期望 3，未记忆）"

# ============================================================================
log "场景 8: mock CopyImageAsset 拒绝非绝对路径（🟡-1）"
fresh
agent-browser eval "(() => { window.__imgErr = ''; window.__litemd__bindings.CopyImageAsset('relative/path.png', 'aGVsbG8=').then(()=>{window.__imgErr='NO_ERROR'}).catch(e=>{window.__imgErr = e.message || 'rejected'}); return 1; })()" > /dev/null 2>&1
sleep 0.5
IMGERR=$(evs "window.__imgErr")
if echo "$IMGERR" | grep -qi 'unsafe\|absolute\|rejected'; then
    ok "非绝对路径被拒绝（${IMGERR}）"
else
    fail "非绝对路径未被拒绝（__imgErr='${IMGERR}'）"
fi

# ============================================================================
echo
echo "═══════════════════════════════════════════════"
echo " Sprint 8 测试结果：${PASS} 通过 / ${FAIL} 失败"
echo "═══════════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
