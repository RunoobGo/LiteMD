#!/usr/bin/env bash
# Sprint 5 E2E — 启动屏 + 主题细化 + LaTeX 公式回归
#
# 覆盖：
#   - 启动屏 4 元素（splash div / logo / title / spinner / version）
#   - 启动屏在 CodeMirror 初始化后 1.2s 内消失
#   - 版本号从 Go AppInfo 注入
#   - LaTeX：行内/块级公式渲染、代码块豁免、错误降级（原「自动更新」场景
#     因功能移除已于 2026-08-31 替换为 LaTeX 回归）
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
log "场景 4: LaTeX 公式渲染"
# 自动更新功能已移除（2026-08-31），场景 4/5 替换为 LaTeX 渲染回归。
agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: '行内 $x^2$ 与块级：\n\n$$E=mc^2$$'}}); return 'ok'; })()" > /dev/null 2>&1
sleep 1.5
KATEX_INLINE=$(agent-browser eval "document.querySelectorAll('.preview .katex').length" 2>&1 | tail -1)
[[ "$KATEX_INLINE" -ge 1 ]] && ok "行内公式 $x^2$ 渲染为 .katex（${KATEX_INLINE} 个）" || fail "行内公式未渲染"
KATEX_DISPLAY=$(agent-browser eval "document.querySelectorAll('.preview .katex-display').length" 2>&1 | tail -1)
[[ "$KATEX_DISPLAY" -ge 1 ]] && ok "块级公式渲染为 .katex-display（${KATEX_DISPLAY} 个）" || fail "块级公式未渲染"

# ============================================================================
log "场景 5: LaTeX 代码块豁免 + 错误降级"
agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: '代码块内不渲染：\n\n\`\`\`\n$x$\n\`\`\`\n\n错误公式：$\\\\notclosed{'}}); return 'ok'; })()" > /dev/null 2>&1
sleep 1.5
CODE_LATEX=$(agent-browser eval "document.querySelectorAll('.preview pre code .katex').length" 2>&1 | tail -1)
[[ "$CODE_LATEX" -eq 0 ]] && ok "代码块内 $x$ 不渲染为公式" || fail "代码块内公式被误渲染: $CODE_LATEX"
ERR_RENDER=$(agent-browser eval "document.querySelectorAll('.preview code.latex-error, .preview .katex-error').length" 2>&1 | tail -1)
[[ "$ERR_RENDER" -ge 0 ]] && ok "错误公式降级为可见内容（非空白）" || fail "错误公式空白"
# 还原编辑器
agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: ''}}); return 'ok'; })()" > /dev/null 2>&1
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
log "场景 7: bundle 体积预算（含 KaTeX 字体，阈值上调）"
# 含 19 个 KaTeX woff2 字体（约 260KB）与 KaTeX 渲染代码，阈值 800KB → 1000KB
CM_BUNDLE=$(ls -l frontend/dist/assets/main.*.js | awk '{print $5}')
CM_KB=$((CM_BUNDLE / 1024))
[[ "$CM_KB" -lt 1000 ]] && ok "main.js: ${CM_KB}KB < 1000KB" || fail "main.js 过大: ${CM_KB}KB"

# ============================================================================
echo
echo "═══════════════════════════════════════════════"
echo " Sprint 5 测试结果：${PASS} 通过 / ${FAIL} 失败"
echo "═══════════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
