// main.ts — LiteMD 主入口（Sprint 3 集成 Obsidian 语法 + frontmatter + 资产）

// 全局样式必须在 main 入口导入，确保 index.html（生产/Wails 桌面入口）也能加载到样式。
// 否则仅 dev.html（浏览器 mock 入口）经 dev-bootstrap.ts 导入样式，桌面端将整体无样式。
import "./style.css";

import { TabManager } from "./tabs";
import { MarkdownEditor } from "./editor";
import { Preview } from "./preview";
import { SplitPane, type SplitMode } from "./splitpane";
import { askUnsaved, installBeforeUnloadGuard } from "./unsaved-guard";
import {
    openFile,
    pickOpenPath,
    saveFile,
    saveFileAs,
    pushRecent,
    copyImageAsset,
} from "./file-ops";
import { parseFrontmatter } from "./obsidian";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;

/**
 * F1 修复：用 <dialog> 替代 alert()，统一错误提示 UX。
 * 文本用 textContent 赋值，避免 XSS；dialog 关闭后自动清除内容。
 */
function showError(title: string, body: string): void {
    const dlg = $("errorDialog") as HTMLDialogElement;
    const titleEl = $("errorTitle");
    const bodyEl = $("errorBody");
    if (!dlg || !titleEl || !bodyEl) {
        // 兜底：dialog 不存在时退回 console
        console.error(`${title}: ${body}`);
        return;
    }
    titleEl.textContent = title;
    bodyEl.textContent = body;
    if (!dlg.open) dlg.showModal();
}

const cmHost = $<HTMLDivElement>("cmHost");
const tabbar = $<HTMLDivElement>("tabbar");
const statusPath = $<HTMLSpanElement>("statusPath");
const statusPos = $<HTMLSpanElement>("statusPos");
const emptyPreview = $<HTMLDivElement>("emptyPreview");
const meta = $<HTMLDivElement>("meta");
const splitRoot = $<HTMLDivElement>("splitpane");
const fmPanel = $<HTMLDetailsElement>("frontmatterPanel") as unknown as HTMLDetailsElement;

// =============================================================================
// TabManager + 编辑器/预览
// =============================================================================

const tm = new TabManager(() => {
    renderTabs();
    refreshActiveEditor();
    renderFrontmatterPanel();
});

let editor: MarkdownEditor | null = null;
let preview: Preview | null = null;
let split: SplitPane | null = null;
let lastRenderedActiveId: string | null = null;

// Preview 渲染 debounce（16ms ~= 一帧；用户连打字时不会每次都全量重新解析）
let previewDebounce: number | null = null;
let pendingContent: string | null = null;
function schedulePreview(content: string) {
    pendingContent = content;
    if (previewDebounce !== null) return;
    previewDebounce = window.setTimeout(() => {
        previewDebounce = null;
        if (pendingContent !== null && preview) {
            const c = pendingContent;
            pendingContent = null;
            // 走 renderPreview 而非直接 preview.render，确保 emptyPreview 空状态同步切换
            renderPreview(c);
        }
    }, 16);
}

function initEditorAndPreview() {
    const initial = tm.active?.liveContent ?? "";
    editor = new MarkdownEditor(
        cmHost,
        initial,
        (content) => {
            const a = tm.active;
            if (a) {
                tm.syncLiveContent(a.id, content);
                schedulePreview(content);
                renderFrontmatterPanel();
                updateMeta();
            }
        },
        { base: "dark" },
        (line, col) => updateStatusPos(line, col)
    );
    // 初始化状态栏光标位置显示
    const pos0 = editor.getCursorPos();
    updateStatusPos(pos0.line, pos0.col);

    // 图片拖入 / 粘贴：复制到资产目录并插入 markdown
    editor.onImageDrop(async (file) => {
        try {
            // F2 修复：改用 FileReader.readAsDataURL 替代 String.fromCharCode.apply，避免大图栈溢出
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error("读取图片失败"));
                reader.readAsDataURL(file);
            });
            // readAsDataURL 返回 "data:image/png;base64,xxxx"，提取纯 base64
            const b64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
            const ts = Date.now().toString(36);
            const safe = file.name.replace(/[^\w.\-]/g, "_");
            const a = tm.active;
            // F3 修复：用 lastIndexOf 安全提取目录
            let assetDir = "/mock/assets/";
            if (a?.path) {
                const lastSlash = Math.max(a.path.lastIndexOf("/"), a.path.lastIndexOf("\\"));
                assetDir = lastSlash >= 0 ? a.path.slice(0, lastSlash + 1) + "assets/" : "assets/";
            }
            const assetPath = `${assetDir}${ts}_${safe}`;
            await copyImageAsset(assetPath, b64);
            const md = `\n![${file.name}](${assetPath})\n`;
            if (editor) editor.setContent(editor.getContent() + md);
        } catch (e) {
            console.warn("image drop failed", e);
            showError("图片插入失败", (e as Error).message ?? String(e));
        }
    });

    preview = new Preview($("preview"));
    if (initial) renderPreviewNow(initial);

    // wiki-link click handler
    preview.onWikiLinkClick(async (target) => {
        if (!target) return;
        const normTarget = target.toLowerCase();
        // 在打开的 tabs 中找匹配
        for (const id of tm.order) {
            const t = tm.get(id);
            if (!t) continue;
            const base = (t.path.split(/[\\/]/).pop() || "").replace(/\.md$/i, "");
            if (base.toLowerCase() === normTarget) {
                tm.activate(id);
                return;
            }
        }
        // 尝试 mock 中查找文件
        try {
            const fs = (window as any).__litemd__mockfs;
            if (fs) {
                const tryPath = `/mock/${target.replace(/\s+/g, "_")}.md`;
                if (fs.files.has(tryPath)) {
                    const payload = await openFile(tryPath);
                    tm.openTab(payload.path, payload.content);
                    return;
                }
            }
        } catch { /* ignore */ }
        showError("Wiki Link 未找到", `目标：${target}\n\n创建文件 "${target}.md" 后可点击跳转`);
    });

    split = new SplitPane(splitRoot, { initialRatio: 0.5 });
    lastRenderedActiveId = tm.activeId;
    renderFrontmatterPanel();
    updateMeta();
}

function refreshActiveEditor() {
    const a = tm.active;
    if (!a) return;
    if (editor && lastRenderedActiveId !== a.id) {
        editor.setContent(a.liveContent);
        lastRenderedActiveId = a.id;
    }
    if (preview) renderPreviewNow(a.liveContent);
    renderFrontmatterPanel();
    updateMeta();
}

function renderPreview(content: string) {
    if (!preview) return;
    if (!content.trim()) {
        preview.clear();
        emptyPreview.hidden = false;
    } else {
        preview.render(content);
        emptyPreview.hidden = true;
    }
}

// 立即渲染预览（用于切 tab、初始化等）
function renderPreviewNow(content: string) {
    if (previewDebounce !== null) {
        window.clearTimeout(previewDebounce);
        previewDebounce = null;
        pendingContent = null;
    }
    renderPreview(content);
}

function updateMeta() {
    const a = tm.active;
    if (!a) {
        meta.textContent = "未保存";
        statusPath.textContent = "未打开文件";
        return;
    }
    meta.textContent = a.dirty ? "● 已修改" : (a.path ? "✓ 已保存" : "○ 新建");
    statusPath.textContent = a.path ? a.path : `${a.title} (未保存)`;
}

/** 更新状态栏光标位置显示（行/列，均从 1 开始） */
function updateStatusPos(line: number, col: number) {
    statusPos.textContent = `行 ${line} · 列 ${col}`;
}

function renderFrontmatterPanel() {
    const a = tm.active;
    if (!a) {
        fmPanel.open = false;
        fmPanel.hidden = true;
        return;
    }
    const { frontmatter } = parseFrontmatter(a.liveContent);
    if (!frontmatter || !Object.keys(frontmatter.data).length) {
        fmPanel.hidden = true;
        fmPanel.open = false;
        a.frontmatter = null;
        return;
    }
    fmPanel.hidden = false;
    a.frontmatter = frontmatter.data as Record<string, string>;
    const keys = Object.keys(frontmatter.data);
    const keysText = keys.map((k) => `${escapeHtml(k)}: ${escapeHtml(String(frontmatter.data[k]))}`).join("  ·  ");
    fmPanel.innerHTML = `
        <summary>
            <strong>Frontmatter</strong>
            <span class="fm-keys">${keysText}</span>
        </summary>
        <div class="fm-body">
            ${keys.map((k) => `<span class="fm-key">${escapeHtml(k)}</span><span class="fm-value">${escapeHtml(String(frontmatter.data[k]))}</span>`).join("")}
        </div>
    `;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    }[c]!));
}

function setMode(mode: SplitMode) {
    if (!split) return;
    split.setMode(mode);
    requestAnimationFrame(() => editor?.focus());
}

// =============================================================================
// 标签栏渲染（与 Sprint 1/2 一致）
// =============================================================================

function renderTabs() {
    tabbar.innerHTML = "";
    for (const id of tm.order) {
        const t = tm.get(id);
        if (!t) continue;
        const el = document.createElement("div");
        el.className = "tab" + (id === tm.activeId ? " active" : "");
        el.setAttribute("role", "tab");
        el.dataset.id = id;

        const title = document.createElement("span");
        title.className = "title";
        title.textContent = t.title;
        el.appendChild(title);

        if (t.dirty) {
            const dot = document.createElement("span");
            dot.className = "dirty";
            dot.textContent = "●";
            dot.title = "存在未保存修改";
            el.appendChild(dot);
        }

        const close = document.createElement("button");
        close.className = "close";
        close.textContent = "×";
        close.title = "关闭标签";
        close.dataset.action = "close-tab";
        close.dataset.id = id;
        el.appendChild(close);

        el.addEventListener("mousedown", (e) => {
            const target = e.target as HTMLElement;
            if (target.dataset.action === "close-tab") {
                e.preventDefault();
                handleCloseTab(id);
            } else {
                if (tm.activeId !== id) tm.activate(id);
            }
        });
        close.addEventListener("click", (e) => {
            e.stopPropagation();
            handleCloseTab(id);
        });
        tabbar.appendChild(el);
    }
}

// =============================================================================
// 按钮
// =============================================================================

document.querySelectorAll<HTMLButtonElement>(".actions button").forEach((btn) => {
    btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        switch (action) {
            case "new": handleNew(); break;
            case "open": handleOpen(); break;
            case "save": handleSave(); break;
            case "save-as": handleSaveAs(); break;
            case "mode-both": setMode("both"); break;
            case "mode-left": setMode("left"); break;
            case "mode-right": setMode("right"); break;
        }
    });
});

function handleNew() {
    tm.newTab();
    requestAnimationFrame(() => editor?.focus());
}

async function handleOpen() {
    try {
        const path = await pickOpenPath();
        if (!path) return;
        const payload = await openFile(path);
        tm.openTab(payload.path, payload.content);
        pushRecent(payload.path).catch(console.warn);
    } catch (e) {
        showError("打开失败", (e as Error).message ?? String(e));
    }
}

async function handleSave(): Promise<boolean> {
    const a = tm.active;
    if (!a) return false;
    try {
        if (!a.path) {
            return await handleSaveAs();
        }
        const content = editor ? editor.getContent() : a.liveContent;
        await saveFile(a.path, content);
        tm.updateContentBaseline(a.id, content, a.path, Date.now() / 1000);
        renderFrontmatterPanel();
        return true;
    } catch (e) {
        showError("保存失败", (e as Error).message ?? String(e));
        return false;
    }
}

async function handleSaveAs(): Promise<boolean> {
    const a = tm.active;
    if (!a) return false;
    try {
        const content = editor ? editor.getContent() : a.liveContent;
        const newPath = await saveFileAs(a.title || "Untitled.md", content);
        if (!newPath) return false;
        tm.updateContentBaseline(a.id, content, newPath, Date.now() / 1000);
        pushRecent(newPath).catch(console.warn);
        renderFrontmatterPanel();
        return true;
    } catch (e) {
        showError("另存为失败", (e as Error).message ?? String(e));
        return false;
    }
}

async function handleCloseTab(id: string): Promise<void> {
    const t = tm.get(id);
    if (!t) return;
    if (t.dirty) {
        const origActive = tm.activeId;
        if (origActive !== id && origActive) {
            const cur = editor ? editor.getContent() : "";
            tm.setLiveContent(origActive, cur);
            tm.activate(id);
        }
        const choice = await askUnsaved(t.path || t.title);
        if (choice === "cancel") {
            if (origActive) tm.activate(origActive);
            return;
        }
        if (choice === "save") {
            const ok = await handleSave();
            if (!ok) return;
        }
        tm.closeTab(id, true);
    } else {
        tm.closeTab(id, true);
    }
}

// =============================================================================
// 快捷键
// =============================================================================

window.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    if (e.key === "n" || e.key === "N") { e.preventDefault(); handleNew(); }
    else if (e.key === "o" || e.key === "O") { e.preventDefault(); handleOpen(); }
    else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        e.shiftKey ? handleSaveAs() : handleSave();
    }
    else if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        if (tm.activeId) handleCloseTab(tm.activeId);
    }
    else if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        setMode(split?.getMode() === "right" ? "both" : "right");
    }
});

installBeforeUnloadGuard(tm);

// =============================================================================
// 启动
// =============================================================================
tm.newTab();
initEditorAndPreview();
editor!.focus();

// 隐藏启动屏：等 CodeMirror 渲染完第一帧后淡出
requestAnimationFrame(() => {
    requestAnimationFrame(() => {
        const splash = document.getElementById("splash");
        const app = document.getElementById("app");
        // 从 Go 后端拿 AppInfo，更新版本号
        (async () => {
            try {
                const w = window as any;
                const info = await w.go?.main?.App?.AppInfo?.();
                if (info?.version) {
                    const v = document.getElementById("splashVersion");
                    if (v) v.textContent = `v${info.version}`;
                }
            } catch { /* 浏览器模式（mock）下可能没有 go 对象 */ }
        })();
        if (splash) splash.classList.add("fade-out");
        if (app) app.classList.remove("app-hidden");
        // 1s 后从 DOM 移除，释放图层
        setTimeout(() => splash?.remove(), 1200);
    });
});

// 把实例导出供 E2E 测试
declare global {
    interface Window {
        __litemd__split?: SplitPane;
        __litemd__cm?: MarkdownEditor;
        __litemd__tm?: TabManager;
        __litemd__preview?: Preview;
        __getEditorContent?: () => string;
    }
}
window.__litemd__split = split!;
window.__litemd__cm = editor!;
window.__litemd__tm = tm;
window.__litemd__preview = preview!;
window.__getEditorContent = () => editor!.getContent();
