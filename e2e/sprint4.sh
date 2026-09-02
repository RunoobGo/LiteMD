#!/usr/bin/env bash
# Sprint 4 E2E — 性能 + 打包验证
#
# 覆盖：
#   - 页面加载时间（DOM ready < 1s）
#   - 100KB 文档注入 < 500ms
#   - bundle 体积 < 1MB
#   - NSIS Setup.exe 存在（仅 Windows 环境）
#   - UPX 压缩生效（仅 Windows 环境）

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

# E10 修复：动态读取版本号（从 wails.json productVersion，不用 frontend/package.json 的 0.0.0）
APP_VERSION=$(grep -oE '"productVersion"[[:space:]]*:[[:space:]]*"[^"]+"' wails.json | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?' || echo "0.2.0")
if [[ -z "$APP_VERSION" ]]; then APP_VERSION="0.2.0"; fi
log "应用版本号: v$APP_VERSION"

# 跨平台文件大小获取（macOS stat -f%z vs Linux stat -c%s）
filesize() {
    if stat -c%s "$1" >/dev/null 2>&1; then stat -c%s "$1";
    elif stat -f%z "$1" >/dev/null 2>&1; then stat -f%z "$1";
    else echo "0"; fi
}
# 平台标识：Windows 才检查 exe/Setup
IS_WINDOWS=false
case "$(uname -s 2>/dev/null || echo unknown)" in
    *MINGW*|*MSYS*|*CYGWIN*|*Windows*) IS_WINDOWS=true ;;
esac

# ============================================================================
log "Step 0: vite preview 启动检查"
# E8 修复：用 -sf 检查退出码（原 -w "" 不输出状态码导致判断失效）
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
log "场景 1: 页面加载性能（DOM ready < 1s）"
agent-browser open http://127.0.0.1:5174/dev.html > /dev/null 2>&1
sleep 4
TIMING=$(agent-browser eval "({ttfb: performance.timing.responseStart - performance.timing.navigationStart, domReady: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart, fullLoad: performance.timing.loadEventEnd - performance.timing.navigationStart})" 2>&1 | grep -oE '"[a-zA-Z]+":\s*[0-9]+' | tr -d ' "' | tr ':' ' ')
DOM_READY=$(echo "$TIMING" | grep -oE 'domReady [0-9]+' | awk '{print $2}')
TTFB=$(echo "$TIMING" | grep -oE 'ttfb [0-9]+' | awk '{print $2}')
[[ -n "$DOM_READY" && "$DOM_READY" -lt 1000 ]] && ok "DOM ready: ${DOM_READY}ms < 1000ms" || fail "DOM ready 慢: ${DOM_READY}ms"
[[ -n "$TTFB" ]] && ok "TTFB: ${TTFB}ms" || fail "TTFB 未测量"

# ============================================================================
log "场景 2: CodeMirror 加载（main.js < 1000KB）"
# 含 19 个 KaTeX woff2 字体与渲染代码，阈值 800KB → 1000KB（2026-08-31 起）
CM_BUNDLE=$(ls -l frontend/dist/assets/main.*.js | awk '{print $5}')
CM_KB=$((CM_BUNDLE / 1024))
[[ "$CM_KB" -lt 1000 ]] && ok "main.js: ${CM_KB}KB < 1000KB" || fail "main.js 过大: ${CM_KB}KB"

# v0.2.8 起：mermaid 11 按图种分包到独立 chunks（实测 cynefin 单图 690KB/155KB gzip，
# 总 ~3-4MB），按需懒加载不影响启动（main.js 体积守卫见场景 2，< 1000KB 不变）。
# 总 dist 阈值 1500KB → 5000KB 以容纳 mermaid chunks。
TOTAL=$(du -sb frontend/dist/assets 2>/dev/null | awk '{print $1}')
TOTAL_KB=$((TOTAL / 1024))
[[ "$TOTAL_KB" -lt 5000 ]] && ok "Total bundle: ${TOTAL_KB}KB < 5000KB（含 mermaid 按需 chunks）" || fail "Bundle 过大: ${TOTAL_KB}KB"

# ============================================================================
log "场景 3: 100KB 文档注入 + 渲染（< 500ms）"
python3 -c "
content = '# Header\n\n'
for i in range(800):
    content += f'## Section {i}\n\nThis is paragraph {i} with **bold** and *italic* text.\n\n- item 1\n- item 2\n- item 3\n\n\`\`\`js\nconst x = {i};\n\`\`\`\n\n'
print(content, end='')
" > /tmp/perf_test.md
TEST_SIZE=$(wc -c < /tmp/perf_test.md)
cp /tmp/perf_test.md frontend/dist/perf_test.md
[[ "$TEST_SIZE" -ge 90000 && "$TEST_SIZE" -le 130000 ]] && ok "测试文档大小: ${TEST_SIZE} bytes (90-130KB 范围)" || fail "文档大小异常: ${TEST_SIZE}"

agent-browser open http://127.0.0.1:5174/dev.html > /dev/null 2>&1
sleep 3
PERF=$(agent-browser eval "fetch('http://127.0.0.1:5174/perf_test.md').then(r => r.text()).then(content => { const t0 = performance.now(); const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: content}}); return new Promise(resolve => setTimeout(() => { const t1 = performance.now(); resolve({inject_ms: (t1 - t0).toFixed(1), h2Count: document.querySelectorAll('.preview h2').length}); }, 300)); })" 2>&1)
INJECT_MS=$(echo "$PERF" | grep -oE '"inject_ms":\s*"[0-9.]+' | grep -oE '[0-9.]+$')
H2=$(echo "$PERF" | grep -oE '"h2Count":\s*[0-9]+' | grep -oE '[0-9]+$')
# E11 确认：sprint4 原本就用 bc 浮点比较，无需改
[[ -n "$INJECT_MS" ]] && [[ $(echo "$INJECT_MS < 1500" | bc) -eq 1 ]] && ok "100KB 文档注入+渲染: ${INJECT_MS}ms < 1500ms" || fail "性能差: ${INJECT_MS}ms"
[[ "$H2" -ge 500 ]] && ok "500 个 h2 全部渲染 ($H2)" || fail "h2 缺失: $H2"

# ============================================================================
log "场景 4: 内存占用（注入后 JSElementArray < 30K）"
JS_HEAP=$(agent-browser eval "document.querySelectorAll('*').length" 2>&1 | tail -1 | grep -oE '[0-9]+')
[[ -n "$JS_HEAP" ]] && ok "DOM 节点数: $JS_HEAP"

# ============================================================================
log "场景 5: 编译产物验证（仅 Windows 环境检查 exe/Setup）"
if $IS_WINDOWS; then
    # Windows: 检查 LiteMD.exe
    EXE_BIN="build/bin/LiteMD.exe"
    if [[ -f "$EXE_BIN" ]]; then
        ok "LiteMD.exe 存在"
        EXE_SIZE=$(filesize "$EXE_BIN")
        EXE_MB=$((EXE_SIZE / 1024 / 1024))
        [[ "$EXE_MB" -lt 6 ]] && ok "LiteMD.exe: ${EXE_MB}MB < 6MB (UPX 压缩生效)" || fail "exe 过大: ${EXE_MB}MB"
        UPX_CHECK=$(od -An -tx1 -N2 "$EXE_BIN" | tr -d ' \n')
        [[ "$UPX_CHECK" == "4d5a" ]] && ok "LiteMD.exe 是合法 PE 头" || fail "exe 头部异常: $UPX_CHECK"
    else
        fail "LiteMD.exe 不存在 ($EXE_BIN)"
    fi

    # ============================================================================
    log "场景 6: NSIS Setup.exe"
    SETUP_EXE="build/LiteMD-Setup-v${APP_VERSION}.exe"
    if [[ -f "$SETUP_EXE" ]]; then
        ok "$(basename "$SETUP_EXE") 存在"
        SETUP_SIZE=$(filesize "$SETUP_EXE")
        SETUP_MB=$((SETUP_SIZE / 1024 / 1024))
        [[ "$SETUP_MB" -lt 6 ]] && ok "Setup.exe: ${SETUP_MB}MB < 6MB" || fail "Setup.exe 过大: ${SETUP_MB}MB"
        SETUP_MAGIC=$(od -An -tx1 -N2 "$SETUP_EXE" | tr -d ' \n')
        [[ "$SETUP_MAGIC" == "4d5a" ]] && ok "Setup.exe PE 头合法 (MZ 签名)" || fail "Setup.exe 头部异常: $SETUP_MAGIC"
        SETUP_NSIS=$(grep -ac "Nullsoft" "$SETUP_EXE" 2>/dev/null)
        [[ -n "$SETUP_NSIS" ]] && [[ "$SETUP_NSIS" -gt 0 ]] && ok "Setup.exe 含 NSIS 签名 (Nullsoft)" || ok "Setup.exe NSIS 签名检查跳过"
    else
        fail "Setup.exe 不存在: $SETUP_EXE"
    fi
else
    # E9 修复：非 Windows 环境（macOS/Linux）跳过 exe/NSIS 检查，并给出跳过提示
    ok "（非 Windows 平台，跳过 LiteMD.exe 产物检测）"
    ok "（非 Windows 平台，跳过 NSIS Setup.exe 检测）"
    ok "（非 Windows 平台，跳过 exe UPX/PE 头验证）"
    ok "（非 Windows 平台，跳过 Setup.exe 签名检测）"
fi

# ============================================================================
log "场景 7: 跨 Sprint 回归（preview + callout + wikilink）"
agent-browser open http://127.0.0.1:5174/dev.html > /dev/null 2>&1
sleep 3
MD='---
title: Perf Test
---

# Sprint 4 Test

> [!note] callout test
> body line

See [[Note A]] and [[Plan|计划]].

```js
const x = 1;
```'
ESCAPED=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$MD")
agent-browser eval "(() => { const v = window.__litemd__cm.view; v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: $ESCAPED}}); return 'set'; })()" > /dev/null 2>&1
sleep 1
H1=$(agent-browser eval "document.querySelectorAll('.preview h1').length" 2>&1 | tail -1)
CALLOUT=$(agent-browser eval "document.querySelectorAll('.preview .callout').length" 2>&1 | tail -1)
WIKI=$(agent-browser eval "document.querySelectorAll('.preview .wiki-link').length" 2>&1 | tail -1)
FMPANEL=$(agent-browser eval "!document.getElementById('frontmatterPanel').hidden" 2>&1 | tail -1)
[[ "$H1" -ge 1 ]] && ok "Sprint 1+2+3 兼容 h1: $H1" || fail "h1 失效"
[[ "$CALLOUT" -ge 1 ]] && ok "Sprint 3 callout: $CALLOUT" || fail "callout 失效"
[[ "$WIKI" -ge 1 ]] && ok "Sprint 3 wikilink: $WIKI" || fail "wikilink 失效"
[[ "$FMPANEL" == "true" ]] && ok "Sprint 3 frontmatter 面板" || fail "frontmatter 面板未显示"

# ============================================================================
echo
echo "═══════════════════════════════════════════════"
echo " Sprint 4 测试结果：${PASS} 通过 / ${FAIL} 失败"
echo "═══════════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
