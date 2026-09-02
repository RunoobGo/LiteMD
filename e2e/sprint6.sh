#!/usr/bin/env bash
# Sprint 6 E2E — 目录树（大纲）侧边栏 + 三模式点击跳转
#
# 覆盖：
#   - 侧边栏：默认可见 / 按钮开关 / Ctrl+B 快捷键 / 宽度持久化
#   - 大纲解析：围栏代码块豁免、Setext 标题、frontmatter 豁免、层级缩进
#   - 折叠：twisty 点击、折叠态按路径（path）而非标题文字保存
#   - 跳转：仅预览 / 分屏 / 仅编辑 三种模式点击大纲均能定位
#   - 反向同步：手动滚动预览时大纲高亮跟随
#
# 注意：跳转场景依赖真实布局（getBoundingClientRect / scrollTop），
# jsdom 不做布局无法断言，因此只在本脚本（真实 Chromium）中覆盖，
# 单测 src/toc.test.ts 只覆盖纯解析逻辑。

set -uo pipefail

cd "$(dirname "$0")/.."
PROJECT=$(pwd)

# 与 sprint1~5 保持一致：预检 agent-browser CLI
if ! command -v agent-browser >/dev/null 2>&1; then
    echo "❌ 错误: agent-browser CLI 未安装或不在 PATH 中"
    echo "请安装 \`@trae/agent-browser\` 插件或运行 npm 安装对应 CLI"
    exit 2
fi

PASS=0
FAIL=0

ok() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
log() { echo; echo "── $1 ──"; }

# eval 包装：agent-browser 输出可能混入 stderr，统一取最后一行
ev() { agent-browser eval "$1" 2>&1 | tail -1; }
# 字符串值：agent-browser 返回带引号的 JSON（如 "on"），比较前需剥掉首尾引号
evs() { agent-browser eval "$1" 2>&1 | tail -1 | sed -e 's/^"//' -e 's/"$//'; }
# 可见条目数：折叠是 ul.hidden=true，节点仍在 DOM，必须排除被隐藏的子树
evrows() {
    agent-browser eval "[...document.querySelectorAll('#tocPanel .toc-row')].filter(r=>!r.closest('ul[hidden]')).length" 2>&1 | tail -1
}

# ============================================================================
log "Step 0: vite preview 启动检查"
# 依赖 frontend/dist（go:embed 与 vite preview 都从这里取产物）
if [ ! -f frontend/dist/assets/main.*.js ] 2>/dev/null && [ ! -d frontend/dist ]; then
    echo "❌ 缺少 frontend/dist，请先执行: cd frontend && npm run build"
    exit 2
fi
if ! curl -sf -o /dev/null http://127.0.0.1:5174/dev.html; then
    cd frontend && (nohup npx vite preview --port 5174 --strictPort > /tmp/vite_preview.log 2>&1 &) && cd ..
    sleep 4
fi
if curl -sf -o /dev/null http://127.0.0.1:5174/dev.html; then
    echo "vite=200"
else
    echo "vite=DOWN"
fi

agent-browser open http://127.0.0.1:5174/dev.html > /dev/null 2>&1
sleep 3  # 等 splash 淡出 + CodeMirror 初始化

# ============================================================================
log "场景 1: 侧边栏可见性与开关"
SIDEBAR_EXISTS=$(ev "!!document.getElementById('sidebar')")
[[ "$SIDEBAR_EXISTS" == "true" ]] && ok "sidebar 元素存在" || fail "sidebar 缺失"

VIS_INIT=$(evs "document.getElementById('app').dataset.sidebar")
[[ "$VIS_INIT" == "on" ]] && ok "默认状态: 侧边栏可见 (data-sidebar=on)" || fail "默认状态异常: $VIS_INIT"

# 按钮关闭
agent-browser eval "document.querySelector('.actions button[data-action=toggle-sidebar]').click()" > /dev/null 2>&1
sleep 0.6
VIS_OFF=$(evs "document.getElementById('app').dataset.sidebar")
[[ "$VIS_OFF" == "off" ]] && ok "按钮点击后隐藏 (data-sidebar=off)" || fail "按钮未隐藏侧边栏: $VIS_OFF"

# Ctrl+B 重新打开
agent-browser eval "document.dispatchEvent(new KeyboardEvent('keydown', {key:'b', ctrlKey:true, bubbles:true}))" > /dev/null 2>&1
sleep 0.6
VIS_ON=$(evs "document.getElementById('app').dataset.sidebar")
[[ "$VIS_ON" == "on" ]] && ok "Ctrl+B 快捷键重新显示" || fail "Ctrl+B 无效: $VIS_ON"

# 宽度持久化
W=$(evs "(() => { const k='litemd:sidebar:width'; localStorage.setItem(k,'300'); return localStorage.getItem(k); })()")
[[ "$W" == "300" ]] && ok "宽度写入 localStorage: ${W}px" || fail "宽度持久化失败: $W"

# ============================================================================
log "场景 2: 大纲解析（真实 DOM）"
# 含 frontmatter / 围栏代码块内的 # / Setext 标题 / 七级 #
DOC='---
title: 这不是标题
---

# 一级标题

```bash
# 这是 shell 注释，不是标题
echo hi
```

## 二级标题

Setext 标题
===========

### 三级标题

####### 七级不算标题

内容段落。
'
agent-browser eval "window.__litemd__cm.setContent(\`$(printf '%s' "$DOC" | sed 's/`/\\`/g')\`)" > /dev/null 2>&1
sleep 1.2

TOC_N=$(ev "document.querySelectorAll('#tocPanel .toc-row').length")
# 期望 4 条：一级 / 二级 / Setext(H1) / 三级
[[ "$TOC_N" -eq 4 ]] && ok "大纲条目数 ${TOC_N}（frontmatter、代码块内 #、七级 # 均被豁免）" \
    || fail "大纲条目数 ${TOC_N}，期望 4"

TOC_TEXTS=$(evs "[...document.querySelectorAll('#tocPanel .toc-text')].map(e=>e.textContent).join('|')")
echo "    条目: $TOC_TEXTS"
case "$TOC_TEXTS" in
    *"一级标题"*) ok "ATX 一级标题入纲" ;;
    *) fail "一级标题缺失" ;;
esac
case "$TOC_TEXTS" in
    *"shell 注释"*) fail "代码块内的 # 被误判为标题" ;;
    *) ok "围栏代码块内 # 已豁免" ;;
esac
case "$TOC_TEXTS" in
    *"title"*) fail "frontmatter 字段被误判为标题" ;;
    *) ok "frontmatter 已豁免" ;;
esac
case "$TOC_TEXTS" in
    *"Setext 标题"*) ok "Setext 标题（===）入纲" ;;
    *) fail "Setext 标题缺失" ;;
esac
case "$TOC_TEXTS" in
    *"七级"*) fail "七级 # 被误判为标题" ;;
    *) ok "七级 # 已豁免（CommonMark 上限 H6）" ;;
esac

# 层级缩进：三级标题的 --toc-level 应为 2
LVL=$(evs "(() => { const r=[...document.querySelectorAll('#tocPanel .toc-row')].find(x=>x.querySelector('.toc-text').textContent.includes('三级')); return r ? r.style.getPropertyValue('--toc-level') : 'NA'; })()")
[[ "$LVL" == "2" ]] && ok "层级缩进 --toc-level=2（三级标题）" || fail "层级缩进异常: $LVL"

# ============================================================================
log "场景 3: 折叠 / 展开"
COLLAPSE_DOC='# 根

## 子 A

### 孙 A1

## 子 B
'
agent-browser eval "window.__litemd__cm.setContent(\`$(printf '%s' "$COLLAPSE_DOC" | sed 's/`/\\`/g')\`)" > /dev/null 2>&1
sleep 1.2

BEFORE=$(evrows)
# 折叠「子 A」
agent-browser eval "(() => { const t=[...document.querySelectorAll('#tocPanel .toc-twisty[data-action=toc-toggle]')].find(x=>x.closest('.toc-node').querySelector('.toc-text').textContent.includes('子 A')); if(t) t.click(); return 'x'; })()" > /dev/null 2>&1
sleep 0.6
AFTER=$(evrows)
[[ "$AFTER" -lt "$BEFORE" ]] && ok "折叠后可见条目 ${BEFORE} → ${AFTER}" || fail "折叠无效: ${BEFORE} → ${AFTER}"

# 改标题文字后折叠态应保持（按 path 而非文字作为 key）
agent-browser eval "(() => { const v=window.__litemd__cm.view; const t=v.state.doc; const i=t.toString().indexOf('子 A'); v.dispatch({changes:{from:i,to:i+4,insert:'子 AAA'}}); return 'x'; })()" > /dev/null 2>&1
sleep 1.2
AFTER2=$(evrows)
[[ "$AFTER2" -eq "$AFTER" ]] && ok "改标题文字后折叠态保留（path 键，条目仍为 ${AFTER2}）" \
    || fail "改文字后折叠态丢失: ${AFTER} → ${AFTER2}"

# 展开还原
agent-browser eval "(() => { const t=[...document.querySelectorAll('#tocPanel .toc-twisty[data-action=toc-toggle]')].find(x=>x.closest('.toc-node').querySelector('.toc-text').textContent.includes('子 AAA')); if(t) t.click(); return 'x'; })()" > /dev/null 2>&1
sleep 0.6
BACK=$(evrows)
[[ "$BACK" -eq "$BEFORE" ]] && ok "展开后恢复 ${BACK} 条" || fail "展开未恢复: ${BACK}（期望 ${BEFORE}）"

# ============================================================================
log "场景 4: 仅预览模式点击跳转（v0.2.2 修复点）"
# 构造长文档，保证有可滚动空间
agent-browser eval "(() => { const parts=['# 文档开头','','开头段落。','']; for(let i=1;i<=30;i++){parts.push('## 第 '+i+' 章 标题','','这是第 '+i+' 章的正文内容，用于撑开高度。','','### 第 '+i+'.1 小节','',i+'.1 的正文。','');} window.__litemd__cm.setContent(parts.join('\n')); return 'x'; })()" > /dev/null 2>&1
sleep 1.5

agent-browser eval "document.querySelector('button[data-action=mode-right]').click()" > /dev/null 2>&1
sleep 0.8
agent-browser eval "document.getElementById('preview').scrollTop = 0" > /dev/null 2>&1
sleep 0.3

SCROLL_BEFORE=$(ev "Math.round(document.getElementById('preview').scrollTop)")
# 取一个靠后的标题作目标
TARGET_LINE=$(ev "(() => { const rows=[...document.querySelectorAll('#tocPanel .toc-row')]; const r=rows[Math.floor(rows.length*0.7)]; return Number(r.dataset.line); })()")
echo "    跳转目标行: ${TARGET_LINE}（点击前 scrollTop=${SCROLL_BEFORE}）"

agent-browser eval "document.querySelector('#tocPanel .toc-row[data-line=\"${TARGET_LINE}\"]').click()" > /dev/null 2>&1
sleep 0.8

SCROLL_AFTER=$(ev "Math.round(document.getElementById('preview').scrollTop)")
TOP=$(ev "(() => { const h=document.getElementById('preview'); const el=h.querySelector('[data-line=\"${TARGET_LINE}\"]'); return el ? Math.round(el.getBoundingClientRect().top - h.getBoundingClientRect().top) : null; })()")
echo "    点击后 scrollTop=${SCROLL_AFTER}，目标标题距预览顶部=${TOP}px（期望 ≈8px 留白）"

[[ "$SCROLL_AFTER" -gt 0 ]] && ok "预览发生滚动（0 → ${SCROLL_AFTER}）" || fail "预览未滚动: ${SCROLL_AFTER}"
if [[ "$TOP" =~ ^-?[0-9]+$ ]]; then
    D=$(( TOP - 8 )); [[ $D -lt 0 ]] && D=$(( -D ))
    [[ "$D" -le 12 ]] && ok "目标标题对齐到预览顶部（偏移 ${TOP}px，容差 12px）" \
        || fail "对齐偏差过大: ${TOP}px"
else
    fail "找不到目标行 ${TARGET_LINE} 对应的预览块"
fi
ACTIVE=$(ev "document.querySelectorAll('#tocPanel .toc-row.active').length")
[[ "$ACTIVE" -eq 1 ]] && ok "跳转后大纲高亮唯一（${ACTIVE} 项）" || fail "高亮项数异常: ${ACTIVE}"

# ============================================================================
log "场景 5: 预览滚动驱动高亮（反向同步）"
agent-browser eval "document.getElementById('preview').scrollTop += 600" > /dev/null 2>&1
sleep 0.8
ACTIVE2=$(ev "document.querySelectorAll('#tocPanel .toc-row.active').length")
ACT_TXT=$(evs "(() => { const e=document.querySelector('#tocPanel .toc-row.active .toc-text'); return e?e.textContent:'无'; })()")
[[ "$ACTIVE2" -eq 1 ]] && ok "手动滚动后高亮唯一：「${ACT_TXT}」" || fail "滚动跟随高亮异常: ${ACTIVE2} 项"
agent-browser screenshot "" e2e/sprint6-preview-jump.png > /dev/null 2>&1

# ============================================================================
log "场景 6: 分屏模式跳转"
agent-browser eval "document.querySelector('button[data-action=mode-both]').click()" > /dev/null 2>&1
sleep 0.8
agent-browser eval "document.getElementById('preview').scrollTop = 0" > /dev/null 2>&1
sleep 0.3
agent-browser eval "document.querySelector('#tocPanel .toc-row[data-line=\"${TARGET_LINE}\"]').click()" > /dev/null 2>&1
sleep 0.8

CLINE=$(ev "window.__litemd__cm.getCursorPos().line")
PSCROLL=$(ev "Math.round(document.getElementById('preview').scrollTop)")
[[ "$CLINE" == "$TARGET_LINE" ]] && ok "编辑器光标定位到第 ${CLINE} 行" || fail "光标行 ${CLINE}，期望 ${TARGET_LINE}"
[[ "$PSCROLL" -gt 0 ]] && ok "预览同步滚动到 ${PSCROLL}" || fail "预览未同步滚动: ${PSCROLL}"
agent-browser screenshot "" e2e/sprint6-split-jump.png > /dev/null 2>&1

# ============================================================================
log "场景 7: 仅编辑模式跳转"
agent-browser eval "document.querySelector('button[data-action=mode-left]').click()" > /dev/null 2>&1
sleep 0.8
agent-browser eval "document.querySelector('#tocPanel .toc-row[data-line=\"${TARGET_LINE}\"]').click()" > /dev/null 2>&1
sleep 0.8
CLINE2=$(ev "window.__litemd__cm.getCursorPos().line")
[[ "$CLINE2" == "$TARGET_LINE" ]] && ok "仅编辑模式光标定位到第 ${CLINE2} 行" || fail "光标行 ${CLINE2}，期望 ${TARGET_LINE}"

# ============================================================================
log "场景 8: 空文档与无标题文档"
agent-browser eval "window.__litemd__cm.setContent('')" > /dev/null 2>&1
sleep 1
EMPTY=$(evs "(() => { const e=document.querySelector('#tocPanel .toc-empty'); return e?e.textContent:'NA'; })()")
[[ -n "$EMPTY" && "$EMPTY" != "NA" ]] && ok "空文档占位提示：「${EMPTY}」" || fail "空文档无占位提示"

agent-browser eval "window.__litemd__cm.setContent('正文一段，没有标题。')" > /dev/null 2>&1
sleep 1
NOHEAD=$(evs "(() => { const e=document.querySelector('#tocPanel .toc-empty'); return e?e.textContent:'NA'; })()")
case "$NOHEAD" in
    *"暂无标题"*) ok "无标题文档提示：「${NOHEAD}」" ;;
    *) fail "无标题提示异常: $NOHEAD" ;;
esac

# ============================================================================
log "场景 9: 跨 Sprint 回归"
agent-browser eval "document.querySelector('button[data-action=new]').click()" > /dev/null 2>&1
sleep 1
TAB_COUNT=$(ev "document.querySelectorAll('#tabbar .tab').length")
[[ "$TAB_COUNT" -ge 2 ]] && ok "Sprint 1 多标签: ${TAB_COUNT} 个" || fail "标签数: $TAB_COUNT"

HAS_CM=$(ev "!!document.querySelector('.cm-editor')")
[[ "$HAS_CM" == "true" ]] && ok "Sprint 2 CodeMirror" || fail "CodeMirror 缺失"

agent-browser eval "window.__litemd__cm.setContent('# Test\n\n> [!note] note\n\n[[Link]]')" > /dev/null 2>&1
sleep 1
H1=$(ev "document.querySelectorAll('.preview h1').length")
CALLOUT=$(ev "document.querySelectorAll('.preview .callout').length")
WIKI=$(ev "document.querySelectorAll('.preview .wiki-link').length")
[[ "$H1" -ge 1 ]] && ok "Sprint 3 h1" || fail "h1 缺失"
[[ "$CALLOUT" -ge 1 ]] && ok "Sprint 3 callout" || fail "callout 缺失"
[[ "$WIKI" -ge 1 ]] && ok "Sprint 3 wikilink" || fail "wikilink 缺失"

# ============================================================================
echo
echo "═══════════════════════════════════════════════"
echo " Sprint 6 测试结果：${PASS} 通过 / ${FAIL} 失败"
echo "═══════════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
