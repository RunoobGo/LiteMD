// main.ts — LiteMD 主入口（Sprint 3 集成 Obsidian 语法 + frontmatter + 资产）

// 全局样式必须在 main 入口导入，确保 index.html（生产/Wails 桌面入口）也能加载到样式。
// 否则仅 dev.html（浏览器 mock 入口）经 dev-bootstrap.ts 导入样式，桌面端将整体无样式。
//
// KaTeX 样式必须先于 style.css 加载：后者内含针对暗色主题的公式适配规则，
// 需要在层叠顺序上压过 katex.min.css 的默认值。
import "katex/dist/katex.min.css";
import "./style.css";

import { TabManager } from "./tabs";
import { MarkdownEditor } from "./editor";
import { Preview } from "./preview";
import { SplitPane, type SplitMode } from "./splitpane";
import { SyncScroll } from "./sync-scroll";
import { askUnsaved, confirmQuit, installBeforeUnloadGuard } from "./unsaved-guard";
import {
    openFile,
    pickOpenPath,
    saveFile,
    saveFileAs,
    pushRecent,
    copyImageAsset,
} from "./file-ops";
import { parseFrontmatter } from "./obsidian";
import { buildImageMarkdown, normalizeImagePath } from "./md-escape";
import { ConsumeStartupFile } from "../wailsjs/go/main/App";
import { EventsOn, WindowIsMaximised, WindowMinimise, WindowToggleMaximise, Quit } from "../wailsjs/runtime/runtime";
import { initTitlebar } from "./titlebar";

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
const meta = $<HTMLDivElement>("meta");
const splitRoot = $<HTMLDivElement>("splitpane");
const fmPanel = $<HTMLDetailsElement>("frontmatterPanel") as unknown as HTMLDetailsElement;

// =============================================================================
// 主题（暗/亮切换）。index.html 头部内联脚本已在解析阶段读取 localStorage
// 并设置 <html data-theme>，这里负责运行时切换、编辑器同步与偏好持久化。
// =============================================================================

const THEME_KEY = "litemd:theme";
type ThemeBase = "dark" | "light";

function currentThemeBase(): ThemeBase {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

// 主题过渡动画窗口：<html> 临时挂 .theme-anim 让 CSS 过渡颜色（约 300ms），
// 到期移除以避免常驻 transition 的样式重算开销。快速连续切换时复用定时器。
let themeAnimTimer: number | null = null;

/** 应用主题：<html data-theme>（驱动全部 CSS 变量）+ CodeMirror + 切换按钮提示 */
function applyTheme(base: ThemeBase, persist = true, animate = true): void {
    const root = document.documentElement;
    if (animate) {
        if (themeAnimTimer !== null) window.clearTimeout(themeAnimTimer);
        root.classList.add("theme-anim");
        themeAnimTimer = window.setTimeout(() => {
            root.classList.remove("theme-anim");
            themeAnimTimer = null;
        }, 300);
    }
    root.dataset.theme = base;
    editor?.setTheme({ base });
    const btn = document.querySelector<HTMLButtonElement>(".actions button[data-action='toggle-theme']");
    if (btn) {
        const label = base === "dark" ? "切换为亮色主题" : "切换为暗色主题";
        btn.dataset.tip = label;
        const tip = btn.querySelector(".tip");
        if (tip) tip.textContent = label;
        btn.setAttribute("aria-label", label);
        btn.setAttribute("aria-pressed", String(base === "light"));
    }
    if (persist) {
        try { localStorage.setItem(THEME_KEY, base); } catch { /* 隐私模式等场景下忽略 */ }
    }
}

function toggleTheme(): void {
    applyTheme(currentThemeBase() === "dark" ? "light" : "dark");
}

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
let syncScroll: SyncScroll | null = null;
let lastRenderedActiveId: string | null = null;

// =============================================================================
// 同步滚动（默认开启，偏好持久化）
// =============================================================================

const SYNC_SCROLL_KEY = "litemd:sync-scroll";

function loadSyncScrollPref(): boolean {
    try { return localStorage.getItem(SYNC_SCROLL_KEY) !== "0"; } catch { return true; }
}

function updateSyncScrollButton() {
    const btn = document.querySelector<HTMLButtonElement>(".actions button[data-action='sync-scroll']");
    if (!btn || !syncScroll) return;
    const on = syncScroll.isEnabled();
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
    const label = on ? "同步滚动：开" : "同步滚动：关";
    btn.dataset.tip = label;
    const tip = btn.querySelector(".tip");
    if (tip) tip.textContent = label;
}

function toggleSyncScroll() {
    if (!syncScroll) return;
    syncScroll.setEnabled(!syncScroll.isEnabled());
    try { localStorage.setItem(SYNC_SCROLL_KEY, syncScroll.isEnabled() ? "1" : "0"); } catch { /* 忽略 */ }
    updateSyncScrollButton();
}

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
        { base: currentThemeBase() },
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
            // #9 修复：路径归一为正斜杠（Windows 反斜杠在 Markdown URL 中是转义前缀）
            const assetPath = normalizeImagePath(`${assetDir}${ts}_${safe}`);
            await copyImageAsset(assetPath, b64);
            // #9 修复：alt 与 URL 分别转义/编码，文件名含 ]、目录含空格括号不再破坏语法
            const md = `\n${buildImageMarkdown(file.name, assetPath)}\n`;
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
    setMode(split.getMode()); // 同步顶栏视图模式按钮的初始 active 状态

    // 同步滚动：默认开启（偏好持久化）；仅分屏（both）模式激活
    syncScroll = new SyncScroll(editor, $("preview"));
    syncScroll.setEnabled(loadSyncScrollPref());
    syncScroll.setActive(split.getMode() === "both");
    updateSyncScrollButton();

    lastRenderedActiveId = tm.activeId;
    renderFrontmatterPanel();
    updateMeta();
}

function refreshActiveEditor() {
    const a = tm.active;
    if (!a) {
        // 关闭最后一个标签后：清空工作区并自动新建一个空标签，保证界面始终可用
        if (editor) {
            editor.setContent("");
            lastRenderedActiveId = null;
        }
        if (preview) renderPreviewNow("");
        renderFrontmatterPanel();
        updateMeta();
        // 异步新建标签，避免在 onChange 通知链路中修改 TabManager 状态
        queueMicrotask(() => {
            if (tm.order.length === 0) {
                tm.newTab();
                requestAnimationFrame(() => editor?.focus());
            }
        });
        return;
    }
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
    } else {
        preview.render(content);
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

// frontmatter 面板内容签名：每次按键都会触发本函数，签名不变时跳过 DOM 重建，
// 避免 innerHTML 重排造成的输入期卡顿（面板内容仅由 frontmatter 决定，正文改动无需重渲染）
let lastFmSig: string | null = null; // null = 面板处于隐藏态

function renderFrontmatterPanel() {
    const a = tm.active;
    let data: Record<string, string> | null = null;
    if (a) {
        const { frontmatter } = parseFrontmatter(a.liveContent);
        if (frontmatter && Object.keys(frontmatter.data).length) {
            data = frontmatter.data as Record<string, string>;
        }
    }
    const sig = data ? JSON.stringify(data) : null;
    if (sig === lastFmSig) return;
    lastFmSig = sig;

    if (a) a.frontmatter = data;
    if (!data) {
        fmPanel.hidden = true;
        fmPanel.open = false;
        return;
    }
    fmPanel.hidden = false;
    const keys = Object.keys(data);
    const keysText = keys.map((k) => `${escapeHtml(k)}: ${escapeHtml(String(data[k]))}`).join("  ·  ");
    fmPanel.innerHTML = `
        <summary>
            <strong>Frontmatter</strong>
            <span class="fm-keys">${keysText}</span>
        </summary>
        <div class="fm-body">
            ${keys.map((k) => `<span class="fm-key">${escapeHtml(k)}</span><span class="fm-value">${escapeHtml(String(data[k]))}</span>`).join("")}
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
    // 同步滚动仅在分屏模式有意义（单栏时挂起，避免无效计算）
    syncScroll?.setActive(mode === "both");
    // 同步顶栏视图模式按钮的 .active 高亮，使当前模式一目了然
    document.querySelectorAll<HTMLButtonElement>(".actions button[data-action^='mode-']").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.action === `mode-${mode}`);
    });
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
            case "sync-scroll": toggleSyncScroll(); break;
            case "toggle-theme": toggleTheme(); break;
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
        // 在空新建页上打开 → 覆盖当前标签;其他情况 → 追加新标签
        openInCurrentIfEmpty(payload);
    } catch (e) {
        showError("打开失败", (e as Error).message ?? String(e));
    }
}

/**
 * "在新建页打开文件"专用路径：如果当前活动标签是「未保存的空新建页」，
 * 则把内容就地写入该标签（覆盖），而不是再追加一个新标签。
 * 这与显式 `Ctrl+N` 新建（`handleNew`）不同 —— 后者总应产生新标签。
 * 注意：若当前活动标签是已关联磁盘路径或存在未保存修改，绝不覆盖，避免数据丢失。
 */
function openInCurrentIfEmpty(payload: { path: string; content: string }): void {
    const a = tm.active;
    const isEmptyUntitled = !!a && !a.path && !a.dirty && a.liveContent === "";
    if (isEmptyUntitled) {
        // 复用该 tab：写入路径与内容、重置 dirty 状态、改标题
        tm.replaceTabContent(a!.id, payload);
        // onChange 回调仅刷新 UI，但 lastRenderedActiveId === a.id 会跳过
        // editor.setContent（id 缓存策略），需手动把内容灌入编辑器并重置缓存。
        if (editor) {
            editor.setContent(payload.content);
            lastRenderedActiveId = a!.id;
        }
        if (preview) renderPreviewNow(payload.content);
        renderFrontmatterPanel();
        updateMeta();
    } else {
        tm.openTab(payload.path, payload.content);
    }
    pushRecent(payload.path).catch(console.warn);
}

/**
 * 消费"使用本应用打开"(文件关联)的启动文件。
 * 返回 true 表示成功打开了一个文件;false 表示无待开文件或读取失败
 * (浏览器 mock 环境 ConsumeStartupFile 返回空载荷,自然返回 false)。
 */
async function consumeStartupFile(): Promise<boolean> {
    try {
        const payload = await ConsumeStartupFile();
        if (!payload?.path) return false;
        // 启动时初始 bootTab 是空新建页,用覆盖策略避免出现两个 tab
        openInCurrentIfEmpty(payload);
        return true;
    } catch (e) {
        // 读取失败(文件被移动/权限等):提示但不阻塞启动,回退到新建文档
        showError("打开文件失败", (e as Error).message ?? String(e));
        return false;
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
// 无边框标题栏：窗口控制按钮 + 双击最大化 + 最大化图标同步。
// 浏览器 mock 端无 window.runtime，传 null 使控制按钮整组隐藏。
// =============================================================================
initTitlebar((window as any).runtime ? {
    minimise: () => WindowMinimise(),
    toggleMaximise: () => WindowToggleMaximise(),
    isMaximised: () => WindowIsMaximised(),
    // #3 修复：退出前协商——Wails v2 无 OnBeforeClose 异步协商，Quit() 不触发
    // beforeunload；有未保存修改时先弹 quitDialog，用户确认后才退出。
    quit: () => {
        confirmQuit(tm).then((ok) => { if (ok) Quit(); });
    },
} : null);

// =============================================================================
// 启动
// =============================================================================

// 文件关联支持:先同步创建一个空 tab 保证编辑器/面板初始化安全,
// 再异步消费启动参数携带的关联文件(多选打开会入队多个,循环全部消费);
// 若至少打开了一个文件,静默移除初始空 tab(仅在它未被修改且未关联路径时)。
const bootTabId = tm.newTab().id;
initEditorAndPreview();
applyTheme(currentThemeBase(), false, false); // 启动同步按钮提示/图标，不持久化、不播动画
editor!.focus();

(async () => {
    let openedAny = false;
    while (await consumeStartupFile()) openedAny = true;
    if (!openedAny) return;
    const boot = tm.get(bootTabId);
    if (boot && !boot.dirty && !boot.path) tm.closeTab(bootTabId, true);
})();

// 应用已运行时再次通过文件关联/命令行启动:Go 侧单实例锁截获参数并触发此事件
if ((window as any).runtime) {
    EventsOn("litemd:openExternalFile", async () => {
        while (await consumeStartupFile()) { /* 消费队列中的全部待开文件 */ }
    });
}

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
        __litemd__sync?: SyncScroll;
        __getEditorContent?: () => string;
    }
}
window.__litemd__split = split!;
window.__litemd__cm = editor!;
window.__litemd__tm = tm;
window.__litemd__preview = preview!;
window.__litemd__sync = syncScroll!;
window.__getEditorContent = () => editor!.getContent();
