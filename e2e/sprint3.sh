#!/usr/bin/env bash
# LiteMD Sprint 3 E2E 测试脚本（v2 — heredoc 注入版本）
# 覆盖：Obsidian 双链 / Callouts / YAML Frontmatter / 图片资产

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

log() { echo -e "${BLUE}[S3 E2E]${NC} $*"; }
ok() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}✓${NC} $*"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}✗${NC} $*"; }

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

assert_eq() {
    local desc="$1"; local expr="$2"; local want="$3"
    local got
    got=$(jval "$expr")
    if [[ "$got" == "$want" ]]; then ok "$desc (=$got)"
    else fail "$desc (want=$want got=$got)"; fi
}

assert_ge() {
    local desc="$1"; local expr="$2"; local want="$3"
    local got
    got=$(jval "$expr")
    if [[ -n "$got" ]] && [[ "$got" =~ ^[0-9]+$ ]] && [[ "$got" -ge "$want" ]]; then
        ok "$desc ($got >= $want)"
    else
        fail "$desc ($got < $want)"
    fi
}

# 用 heredoc 注入文件 + python 转义后再 dispatch 给 CM
inject_md_file() {
    local file="$1"
    local esc
    esc=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" < "$file")
    agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: $esc}}); return 'set'; })()" > /dev/null 2>&1
    sleep 2
}

inject_md_inline() {
    # 用临时文件避免 bash 引号嵌套
    local tmpf=$(mktemp /tmp/md.XXXXXX)
    cat > "$tmpf"
    inject_md_file "$tmpf"
    rm "$tmpf"
}

wait_cm() {
    for i in $(seq 1 15); do
        local ready
        ready=$(agent-browser eval "!!document.querySelector('.cm-editor') && !!window.__litemd__cm && !!window.__litemd__cm.view" 2>&1 | tail -1)
        if echo "$ready" | grep -q "true"; then return 0; fi
        sleep 1
    done
    return 1
}

# ============================================================================
log "Step 0: 打开 dev 页面 + 等 CodeMirror 加载"
agent-browser open "$URL" > /dev/null 2>&1
sleep 1
if wait_cm; then ok "CodeMirror 加载"
else fail "CodeMirror 未就绪"; fi
sleep 2

# ============================================================================
log "场景 1: Wiki Link 渲染"
inject_md_inline <<'MD'
see [[Note A]] and [[Project Plan|PP]] also [[Simple Link]]
MD
assert_eq "双链数" "document.querySelectorAll('.preview .wiki-link').length" "3"
WIKI_TEXT=$(jval "document.querySelector('.preview .wiki-link')?.textContent")
[[ "$WIKI_TEXT" == "Note A" ]] && ok "链接文本: $WIKI_TEXT" || fail "链接文本异常: $WIKI_TEXT"
ALIAS_TEXT=$(jval "document.querySelectorAll('.preview .wiki-link')[1]?.textContent")
[[ "$ALIAS_TEXT" == "PP" ]] && ok "别名显示: $ALIAS_TEXT" || fail "别名异常: $ALIAS_TEXT"
WIKI_DATA=$(jval "document.querySelector('.preview .wiki-link')?.dataset?.wikilink")
[[ "$WIKI_DATA" == "Note A" ]] && ok "data-wikilink: $WIKI_DATA" || fail "data-wikilink 异常: $WIKI_DATA"

# ============================================================================
log "场景 2: Callout 渲染"
inject_md_inline <<'MD'
> [!note] 这是 note
> 内部文本

> [!warning] 注意
> 多行警告

> [!danger] 危险操作
MD
assert_eq "callout 总数" "document.querySelectorAll('.preview .callout').length" "3"
assert_eq "note callout" "document.querySelectorAll('.preview .callout-note').length" "1"
assert_eq "warning callout" "document.querySelectorAll('.preview .callout-warning').length" "1"
assert_eq "danger callout" "document.querySelectorAll('.preview .callout-danger').length" "1"
NOTE_TITLE=$(jval "document.querySelector('.preview .callout-note .callout-title')?.textContent")
[[ "$NOTE_TITLE" == "这是 note" ]] && ok "note title: $NOTE_TITLE" || fail "note title 异常: $NOTE_TITLE"
NOTE_BODY=$(jval "document.querySelector('.preview .callout-note .callout-body')?.textContent")
[[ "$NOTE_BODY" == "内部文本" ]] && ok "note body: $NOTE_BODY" || fail "note body 异常: $NOTE_BODY"

# ============================================================================
log "场景 3: YAML Frontmatter 面板"
inject_md_inline <<'MD'
---
title: My Test
tags: [obsidian, md]
author: just
date: 2024-01-01
---

正文开始。
MD

PANEL_VISIBLE=$(jval "!document.getElementById('frontmatterPanel').hidden")
[[ "$PANEL_VISIBLE" =~ ^[Tt]rue$ ]] && ok "frontmatter 面板可见" || fail "frontmatter 面板不可见: $PANEL_VISIBLE"
FM_TEXT=$(jval "document.getElementById('frontmatterPanel').textContent")
if echo "$FM_TEXT" | grep -q "title:" && echo "$FM_TEXT" | grep -q "My Test"; then
    ok "title 字段展示"
else
    fail "title 字段缺失"
fi
if echo "$FM_TEXT" | grep -q "author:" && echo "$FM_TEXT" | grep -q "just"; then
    ok "author 字段展示"
else
    fail "author 字段缺失"
fi

# 没 frontmatter 时面板隐藏
inject_md_inline <<'MD'
# No frontmatter here

just content
MD
PANEL_HIDDEN=$(jval "document.getElementById('frontmatterPanel').hidden")
[[ "$PANEL_HIDDEN" =~ ^[Tt]rue$ ]] && ok "无 frontmatter 时面板隐藏" || fail "面板未隐藏: $PANEL_HIDDEN"

# ============================================================================
log "场景 4: Wiki Link 点击切换到已开文件"
inject_md_inline <<'MD'
see [[sibling]]
MD

# 用 mock 写入 sibling.md 后打开
agent-browser eval "window.__litemd__mockfs.files.set('/mock/sibling.md', '# Sibling Content')" > /dev/null 2>&1
agent-browser eval "(() => { window.__litemd__tm.openTab('/mock/sibling.md', '# Sibling Content'); return 'opened'; })()" > /dev/null 2>&1
sleep 1
TAB_COUNT=$(jval "document.querySelectorAll('#tabbar .tab').length")
[[ "$TAB_COUNT" -ge 2 ]] && ok "标签数 >= 2 (=$TAB_COUNT)" || fail "标签数: $TAB_COUNT"

# 切回 tab-1（默认激活的是 sibling.md）
agent-browser eval "(() => { document.querySelectorAll('#tabbar .tab')[0].dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); return 'sw'; })()" > /dev/null 2>&1
sleep 1
# 点击 wiki-link "sibling" → 应该切到 /mock/sibling.md tab
agent-browser eval "(() => { document.querySelector('.preview .wiki-link').click(); return 'clicked'; })()" > /dev/null 2>&1
sleep 2
ACTIVE_TITLE=$(jval "document.querySelector('#tabbar .tab.active .title')?.textContent")
[[ "$ACTIVE_TITLE" == "sibling.md" ]] && ok "wiki-link click 切换到 sibling.md" || fail "未切换: $ACTIVE_TITLE"

# ============================================================================
log "场景 5: 图片拖入资产复制"
inject_md_inline <<'MD'
拖入图片前的纯文本
MD

PRE_DROP=$(jval "window.__litemd__mockfs.files.size")
agent-browser eval "(() => {
    const blob = new Blob(['fakePngBytes'], { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'test.png', { type: 'image/png' }));
    const target = document.querySelector('.cm-content');
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 200, clientY: 100 });
    target.dispatchEvent(ev);
    return 'dropped';
})()" > /dev/null 2>&1
sleep 3
POST_DROP=$(jval "window.__litemd__mockfs.files.size")
[[ "$POST_DROP" -gt "$PRE_DROP" ]] && ok "拖入后 mock FS 增加 ($PRE_DROP → $POST_DROP)" || fail "mock FS 未增加 ($PRE_DROP = $POST_DROP)"

MD_TEXT=$(jval "window.__litemd__cm.view.state.doc.toString()")
if echo "$MD_TEXT" | grep -q "!\[test.png\]"; then
    ok "markdown 含图片引用"
else
    fail "markdown 未含图片引用"
fi
if echo "$MD_TEXT" | grep -q "/assets/.*test.png"; then
    ok "markdown 路径含 /assets/"
else
    fail "markdown 路径未含 /assets/"
fi

# ============================================================================
log "场景 6: 截图存档"
agent-browser screenshot /workspace/LiteMD/e2e/sprint3-screenshot.png > /dev/null 2>&1
if [[ -f /workspace/LiteMD/e2e/sprint3-screenshot.png ]]; then
    SIZE=$(du -h /workspace/LiteMD/e2e/sprint3-screenshot.png | cut -f1)
    ok "sprint3 截图 ($SIZE)"
else
    fail "sprint3 截图未保存"
fi

# ============================================================================
echo
echo "=========================================="
echo -e "  Sprint 3 通过: ${GREEN}${PASS}${NC}  失败: ${RED}${FAIL}${NC}  合计: ${TOTAL}"
echo "=========================================="

agent-browser close > /dev/null 2>&1 || true
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
