// sidebar.ts — 可折叠、可拖拽调宽的左侧边栏容器
//
// 与具体面板内容解耦：本类只管"容器"的显隐与宽度，面板（大纲 / 未来的文件树）
// 只需往 .sidebar-body 里塞 DOM 即可。

const VISIBLE_KEY = "litemd:sidebar:visible";
const WIDTH_KEY = "litemd:sidebar:width";

export interface SidebarOptions {
    /** 折叠状态变化时回调（供调用方同步按钮高亮） */
    onChange?: (visible: boolean) => void;
    minWidth?: number;
    maxWidth?: number;
    defaultWidth?: number;
}

export class Sidebar {
    private root: HTMLElement;   // #app，CSS 变量挂在这里驱动网格列宽
    private resizer: HTMLElement | null;
    private visible: boolean;
    private width: number;
    private minWidth: number;
    private maxWidth: number;
    private onChange?: (visible: boolean) => void;

    constructor(root: HTMLElement, el: HTMLElement, opts: SidebarOptions = {}) {
        this.root = root;
        this.minWidth = opts.minWidth ?? 160;
        this.maxWidth = opts.maxWidth ?? 480;
        this.onChange = opts.onChange;

        const storedWidth = readNumber(WIDTH_KEY);
        this.width = clamp(storedWidth ?? opts.defaultWidth ?? 240, this.minWidth, this.maxWidth);

        // localStorage 从未写过时视为"默认展开"（null 而非 false）
        const storedVisible = readBool(VISIBLE_KEY);
        this.visible = storedVisible ?? true;

        this.resizer = el.querySelector<HTMLElement>(".sidebar-resizer");
        if (this.resizer) {
            this.resizer.addEventListener("pointerdown", (e) => this.startDrag(e));
            // 双击复位到默认宽度
            this.resizer.addEventListener("dblclick", () => {
                this.width = opts.defaultWidth ?? 240;
                this.applyWidth(true);
            });
        }

        this.applyWidth(false);
        this.applyVisible(false);
    }

    isVisible(): boolean {
        return this.visible;
    }

    setVisible(v: boolean): void {
        if (this.visible === v) return;
        this.visible = v;
        this.applyVisible(true);
    }

    toggle(): void {
        this.setVisible(!this.visible);
    }

    getWidth(): number {
        return this.width;
    }

    // ---- 内部 ----

    private applyVisible(persist: boolean): void {
        this.root.dataset.sidebar = this.visible ? "on" : "off";
        // 同步列宽变量：收起时归零，展开时恢复保存宽度。
        // CSS 规则 #app[data-sidebar="off"] { --sidebar-w: 0px } 会被 #app 上的
        // inline style 覆盖，所以 inline style 必须跟可见性走、不能只跟 width 走，
        // 否则收起后 --sidebar-w 仍是 240px，1fr 内容列吃不到 240px 空间。
        this.root.style.setProperty("--sidebar-w", this.visible ? `${this.width}px` : "0px");
        if (persist) writeBool(VISIBLE_KEY, this.visible);
        this.onChange?.(this.visible);
    }

    private applyWidth(persist: boolean): void {
        // 收起时不动 --sidebar-w（保留 applyVisible 写入的 0px）；拖动也只是改 width，
        // 等下次展开时由 applyVisible 一次性写回。
        if (!this.visible) return;
        this.root.style.setProperty("--sidebar-w", `${this.width}px`);
        if (persist) writeNumber(WIDTH_KEY, this.width);
    }

    private startDrag(e: PointerEvent): void {
        if (!this.visible) return;
        e.preventDefault();
        const handle = e.currentTarget as HTMLElement;
        handle.setPointerCapture(e.pointerId);
        this.root.classList.add("sidebar-dragging");

        const onMove = (ev: PointerEvent) => {
            const rect = this.root.getBoundingClientRect();
            const w = clamp(ev.clientX - rect.left, this.minWidth, this.maxWidth);
            this.width = w;
            this.applyWidth(false); // 拖动中不落盘，抬手时统一写一次
        };
        const onUp = (ev: PointerEvent) => {
            try { handle.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
            this.root.classList.remove("sidebar-dragging");
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            this.applyWidth(true);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        // 审查 🟡-3：与 splitpane 同源——拖拽被系统打断（pointercancel）
        // 不派发 pointerup，必须同听 cancel 才能复位状态、摘除监听器
        window.addEventListener("pointercancel", onUp);
    }
}

// ---- localStorage 读写（不可用隐私模式下静默降级为"不持久化"）----

function readNumber(key: string): number | null {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    } catch { return null; }
}

function writeNumber(key: string, v: number): void {
    try { localStorage.setItem(key, String(Math.round(v))); } catch { /* 忽略 */ }
}

function readBool(key: string): boolean | null {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return null;
        return raw === "1";
    } catch { return null; }
}

function writeBool(key: string, v: boolean): void {
    try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* 忽略 */ }
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

/** 审计 R2 测试补强：导出 clamp 供 sidebar.test.ts 单元测试。 */
export const _internal = { clamp };
