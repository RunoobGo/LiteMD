// titlebar.ts — 无边框窗口标题栏控制
//
// 职责边界：窗口拖动本身由 Wails 内建 dragTest 驱动（CSS 变量
// --wails-draggable，见 style.css 顶栏注释），本模块只负责三件事：
//   1. 窗口控制按钮（最小化/最大化还原/关闭）
//   2. 双击标题栏空白切换最大化
//   3. 最大化状态图标同步（is-maximised）
//
// 为什么关闭用 quit() 而不是 WindowClose：Wails v2.14 前端 runtime
// 不存在 WindowClose API（已核对 wailsjs/runtime/runtime.d.ts），
// 对等能力是 runtime.Quit()，行为与系统关闭按钮一致（均不触发
// beforeunload；未保存协商属 P0-E 待办，此处保持与原生一致）。
//
// 为什么用 resize 事件同步最大化状态：Wails v2.14 Windows 后端不广播
// wails:maximise / wails:unmaximise 事件（已核对
// internal/frontend/desktop/windows 源码），最大化/还原必然伴随窗口
// 尺寸变化，故在 resize 上防抖查询一次 WindowIsMaximised。
//
// 依赖注入设计：窗口操作通过 TitlebarWindow 接口传入，模块本身
// 不 import wailsjs —— 既能在浏览器 mock / jsdom 单测中零依赖运行，
// 也避免了 tsx 直接加载 wailsjs ESM 的模块格式问题。

/** 窗口运行时抽象（由 main.ts 注入 Wails runtime 适配器） */
export interface TitlebarWindow {
    minimise(): void;
    toggleMaximise(): void;
    isMaximised(): Promise<boolean>;
    quit(): void;
}

/** resize → 状态查询的防抖间隔（ms）：连续的尺寸变化只查最后一次 */
const SYNC_DEBOUNCE_MS = 150;

let syncTimer: number | null = null;

/**
 * 初始化标题栏。
 * @param win 窗口运行时；传 null（浏览器 mock / 无边框不可用）时
 *            隐藏窗口控制按钮组，标题栏退化为纯展示。
 */
export function initTitlebar(win: TitlebarWindow | null): void {
    const topbar = document.querySelector<HTMLElement>(".topbar");
    const controls = document.querySelector<HTMLElement>(".window-controls");
    if (!topbar || !controls) return;

    if (!win) {
        controls.hidden = true;
        return;
    }

    // 窗口控制按钮。注意 dblclick 依赖 button 判断排除，选择器用 button 而非 .wc-btn
    controls.querySelectorAll<HTMLButtonElement>("button[data-wc]").forEach((btn) => {
        btn.addEventListener("click", () => {
            switch (btn.dataset.wc) {
                case "min":
                    win.minimise();
                    break;
                case "max":
                    win.toggleMaximise();
                    scheduleSync(win, topbar);
                    break;
                case "close":
                    win.quit();
                    break;
            }
        });
    });

    // 双击标题栏空白切换最大化。
    // Wails dragTest 对 detail!==1 的 mousedown 不启动拖动，双击手势
    // 天然留给这里处理；点在按钮上（含工具栏按钮）不触发。
    topbar.addEventListener("dblclick", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        win.toggleMaximise();
        scheduleSync(win, topbar);
    });

    // 最大化状态同步：最大化/还原/拖动还原均伴随 resize，防抖后查询一次。
    window.addEventListener("resize", () => scheduleSync(win, topbar));
    scheduleSync(win, topbar); // 启动时同步初始状态（如以最大化参数启动）
}

/** 防抖查询最大化状态并同步 topbar.is-maximised 类（驱动图标切换） */
function scheduleSync(win: TitlebarWindow, topbar: HTMLElement): void {
    if (syncTimer !== null) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(async () => {
        syncTimer = null;
        try {
            topbar.classList.toggle("is-maximised", await win.isMaximised());
        } catch {
            /* 查询失败（窗口销毁竞态等）保持当前状态 */
        }
    }, SYNC_DEBOUNCE_MS);
}
