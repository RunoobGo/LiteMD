// titlebar.ts — 无边框窗口标题栏控制
//
// 职责边界：窗口拖动本身由 Wails 内建 dragTest 驱动（CSS 变量
// --wails-draggable，见 style.css 顶栏注释），本模块只负责三件事：
//   1. 窗口控制按钮（最小化/最大化还原/关闭）
//   2. 双击标题栏空白切换最大化
//   3. 最大化状态图标同步（is-maximised）
//
// 为什么关闭走注入的 quit 而不是直调 runtime.Quit：Wails v2.14 前端
// runtime 不存在 WindowClose API（已核对 wailsjs/runtime/runtime.d.ts），
// 对等能力是 runtime.Quit()，而 Quit() 会同步调用 Go 侧 OnBeforeClose
// （见 windows/frontend.go Quit）。main.ts 注入的是 unsaved-guard 的
// requestQuit：前端 quitDialog 协商 → SetUnsavedCount(0) 放行 OnBeforeClose
// → Quit()，避免用户确认后原生框二次弹出。
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
/** 代际序号：审计 R2-F4 防 stale 回调翻转 is-maximised class。
 *  每次 scheduleSync 自增；resolve 时若序号变化说明已被新调用覆盖，
 *  旧结果丢弃。 */
let syncGen = 0;

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
    const myGen = ++syncGen;
    syncTimer = window.setTimeout(async () => {
        syncTimer = null;
        try {
            const isMax = await win.isMaximised();
            // 审计 R2-F4：异步返回时若代际已变（旧调用被新调用覆盖），
            // 丢弃结果，避免 resize → maximize 串行时旧调用晚归翻 class。
            if (myGen !== syncGen) return;
            topbar.classList.toggle("is-maximised", isMax);
        } catch {
            /* 查询失败（窗口销毁竞态等）保持当前状态 */
        }
    }, SYNC_DEBOUNCE_MS);
}
