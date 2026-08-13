#!/usr/bin/env bash
# Sprint 5 E2E — 启动屏 + 自动更新 + 主题细化
#
# 覆盖：
#   - 启动屏 4 元素（splash div / logo / title / spinner / version）
#   - 启动屏在 CodeMirror 初始化后 1.2s 内消失
#   - 版本号从 Go AppInfo 注入
#   - 「检查更新」按钮 + 弹窗存在
#   - 主题：brand 渐变 + button 悬浮 + a 渐变

set -uo pipefail

cd "$(dirname "$0")/.."
PROJECT=$(pwd)

# E13 修复：预检 agent-browser CLI
if ! command -v agent-browser >/dev/null 2>&1; then
    echo "❌ 错误: agent-browser CLI 未安装或不在 PATH 中"
    echo "请参阅 TRAE 文档安装: `@trae/agent-browser` 插件或运行 npm 安装对应 CLI"
    exit 2
fi

PASS=0
FAIL=0

ok() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
log() { echo; echo "── $1 ──"; }

# ============================================================================
log "Step 0: vite preview 启动检查"
# T7 修复：用 -sf 检查退出码，原 -w "" 不输出状态码导致判断失效
if ! curl -sf -o /dev/null http://127.0.0.1:5174/dev.html; then
    cd frontend && (nohup npx vite preview --port 5174 --strictPort > /tmp/vite_preview.log 2>&1 &) && cd ..
    sleep 4
fi
# 再次检查并输出状态码
if curl -sf -o /dev/null http://127.0.0.1:5174/dev.html; then
    echo "vite=200"
else
    echo "vite=DOWN"
fi

# ============================================================================
log "场景 1: 启动屏元素全部就位"
agent-browser open http://127.0.0.1:5174/dev.html > /dev/null 2>&1
sleep 1  # 在 splash 还在的时候采集
SPLASH_ELE=$(agent-browser eval "({splash: !!document.getElementById('splash'), logo: !!document.querySelector('.splash-logo svg'), title: document.querySelector('.splash-title')?.textContent, tagline: document.querySelector('.splash-tagline')?.textContent, spinner: document.querySelectorAll('.splash-spinner span').length, version: document.getElementById('splashVersion')?.textContent})" 2>&1)

[[ $(echo "$SPLASH_ELE" | grep -oE '"splash": true' | wc -l) -ge 1 ]] && ok "splash div 存在" || fail "splash div 缺失"
[[ $(echo "$SPLASH_ELE" | grep -oE '"logo": true' | wc -l) -ge 1 ]] && ok "splash logo SVG 存在" || fail "logo SVG 缺失"
TITLE=$(echo "$SPLASH_ELE" | grep -oE '"title":\s*"[^"]*"' | sed 's/.*"\(.*\)"/\1/')
[[ "$TITLE" == "LiteMD" ]] && ok "splash title: $TITLE" || fail "splash title 异常: $TITLE"
SPINNER=$(echo "$SPLASH_ELE" | grep -oE '"spinner":\s*[0-9]+' | grep -oE '[0-9]+')
[[ "$SPINNER" -ge 3 ]] && ok "splash spinner: $SPINNER 个动效点" || fail "spinner 缺失: $SPINNER"
VERSION=$(echo "$SPLASH_ELE" | grep -oE '"version":\s*"[^"]*"' | sed 's/.*"\(.*\)"/\1/')
[[ -n "$VERSION" ]] && ok "splash 版本号: $VERSION" || fail "version 缺失"

# ============================================================================
log "场景 2: 启动屏在 CodeMirror 初始化后消失"
sleep 4
# splash 在 1.2s 后从 DOM 中完全移除
SPLASH_REMOVED=$(agent-browser eval "document.getElementById('splash') === null || document.getElementById('splash').classList.contains('fade-out')" 2>&1 | tail -1)
[[ "$SPLASH_REMOVED" == "true" ]] && ok "splash 已淡出/移除" || fail "splash 未淡出"
APP_VISIBLE=$(agent-browser eval "!document.getElementById('app').classList.contains('app-hidden')" 2>&1 | tail -1)
[[ "$APP_VISIBLE" == "true" ]] && ok "app 已可见" || fail "app 仍隐藏"

# ============================================================================
log "场景 3: 主题细化"
# brand 渐变
BRAND=$(agent-browser eval "getComputedStyle(document.querySelector('.brand')).backgroundImage.includes('linear-gradient')" 2>&1 | tail -1)
[[ "$BRAND" == "true" ]] && ok "brand 渐变" || fail "brand 无渐变"
# button 过渡
BTN=$(agent-browser eval "getComputedStyle(document.querySelector('.actions button')).transition.includes('transform')" 2>&1 | tail -1)
[[ "$BTN" == "true" ]] && ok "button transform 过渡" || fail "button 无 transform 过渡"
# topbar blur
TB=$(agent-browser eval "getComputedStyle(document.querySelector('.topbar')).backdropFilter !== 'none' || getComputedStyle(document.querySelector('.topbar')).webkitBackdropFilter !== 'none'" 2>&1 | tail -1)
[[ "$TB" == "true" ]] && ok "topbar 玻璃态 backdrop-filter" || fail "topbar 无 backdrop-filter"

# ============================================================================
log "场景 4: 自动更新按钮 + 弹窗"
UPDATE_BTN=$(agent-browser eval "!!document.querySelector('button[data-action=check-update]')" 2>&1 | tail -1)
[[ "$UPDATE_BTN" == "true" ]] && ok "检查更新按钮存在" || fail "检查更新按钮缺失"
UPDATE_DLG=$(agent-browser eval "!!document.getElementById('updateDialog')" 2>&1 | tail -1)
[[ "$UPDATE_DLG" == "true" ]] && ok "更新弹窗存在" || fail "更新弹窗缺失"

# 点击按钮触发检查
agent-browser eval "document.querySelector('button[data-action=check-update]').click()" > /dev/null 2>&1
sleep 2
DLG_OPEN=$(agent-browser eval "document.getElementById('updateDialog').open" 2>&1 | tail -1)
[[ "$DLG_OPEN" == "true" ]] && ok "点击后弹窗打开" || fail "弹窗未打开"
TITLE=$(agent-browser eval "document.getElementById('updateTitle').textContent" 2>&1 | tail -1)
[[ -n "$TITLE" ]] && ok "弹窗标题: $TITLE" || fail "弹窗无标题"

# 关闭弹窗
agent-browser eval "document.getElementById('updateDialog').close('later')" > /dev/null 2>&1
sleep 1

# ============================================================================
log "场景 5: 启动后 5s 自动检查更新（已节流时不再触发）"
# 第二次点击应被节流，但仍能弹窗
agent-browser eval "document.querySelector('button[data-action=check-update]').click()" > /dev/null 2>&1
sleep 1
DLG_OPEN2=$(agent-browser eval "document.getElementById('updateDialog').open" 2>&1 | tail -1)
[[ "$DLG_OPEN2" == "true" ]] && ok "手动检查绕过节流" || fail "手动检查未触发"
agent-browser eval "document.getElementById('updateDialog').close('later')" > /dev/null 2>&1
sleep 1

# ============================================================================
log "场景 6: 跨 Sprint 回归"
# Sprint 1: 多标签
agent-browser eval "(() => { document.querySelector('button[data-action=new]').click(); return 'new'; })()" > /dev/null 2>&1
sleep 1
TAB_COUNT=$(agent-browser eval "document.querySelectorAll('#tabbar .tab').length" 2>&1 | tail -1)
[[ "$TAB_COUNT" -ge 2 ]] && ok "Sprint 1 多标签: $TAB_COUNT 个" || fail "标签数: $TAB_COUNT"

# Sprint 2: CodeMirror + Preview
HAS_CM=$(agent-browser eval "!!document.querySelector('.cm-editor')" 2>&1 | tail -1)
[[ "$HAS_CM" == "true" ]] && ok "Sprint 2 CodeMirror" || fail "CodeMirror 缺失"

# Sprint 3: Obsidian
agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: '# Test\n\n> [!note] note\n\n[[Link]]'}}); return 'ok'; })()" > /dev/null 2>&1
sleep 1
H1=$(agent-browser eval "document.querySelectorAll('.preview h1').length" 2>&1 | tail -1)
CALLOUT=$(agent-browser eval "document.querySelectorAll('.preview .callout').length" 2>&1 | tail -1)
WIKI=$(agent-browser eval "document.querySelectorAll('.preview .wiki-link').length" 2>&1 | tail -1)
[[ "$H1" -ge 1 ]] && ok "Sprint 3 h1" || fail "h1 缺失"
[[ "$CALLOUT" -ge 1 ]] && ok "Sprint 3 callout" || fail "callout 缺失"
[[ "$WIKI" -ge 1 ]] && ok "Sprint 3 wikilink" || fail "wikilink 缺失"

# ============================================================================
log "场景 7: bundle 体积仍 < 1MB（主题细化无大幅膨胀）"
CM_BUNDLE=$(ls -l frontend/dist/assets/main.*.js | awk '{print $5}')
CM_KB=$((CM_BUNDLE / 1024))
[[ "$CM_KB" -lt 800 ]] && ok "main.js: ${CM_KB}KB < 800KB" || fail "main.js 过大: ${CM_KB}KB"

# ============================================================================
echo
echo "═══════════════════════════════════════════════"
echo " Sprint 5 测试结果：${PASS} 通过 / ${FAIL} 失败"
echo "═══════════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
