// splitpane.ts — 可拖拽的分屏容器
//
// 支持三种模式：分屏 / 仅左 / 仅右
// 水平拖拽调整比例，CSS 变量驱动（--split-ratio）

export type SplitMode = "both" | "left" | "right";

export interface SplitPaneOptions {
    /** 比例 0..1，初始 0.5 */
    initialRatio?: number;
    /** 拖拽结束后回调 */
    onChange?: (ratio: number) => void;
}

export class SplitPane {
    private host: HTMLElement;
    private left: HTMLElement;
    private right: HTMLElement;
    private handle: HTMLElement;
    private ratio: number;
    private mode: SplitMode = "both";
    private dragging = false;
    private onChange?: (ratio: number) => void;

    constructor(host: HTMLElement, opts: SplitPaneOptions = {}) {
        this.host = host;
        this.ratio = opts.initialRatio ?? 0.5;
        this.onChange = opts.onChange;

        this.host.classList.add("splitpane");

        this.left = host.querySelector(".pane-left") as HTMLElement;
        this.right = host.querySelector(".pane-right") as HTMLElement;
        this.handle = host.querySelector(".pane-handle") as HTMLElement;

        if (!this.left || !this.right || !this.handle) {
            throw new Error(_internal.MISSING_CHILDREN_MSG);
        }

        this.applyRatio();
        // 构造期同步一次 data-mode（默认 both），让 CSS 选择器立即生效
        this.host.dataset.mode = this.mode;

        this.handle.addEventListener("pointerdown", (e) => this.startDrag(e));
        // 同时处理双击：重置比例
        this.handle.addEventListener("dblclick", () => {
            this.ratio = 0.5;
            this.applyRatio();
            this.onChange?.(this.ratio);
        });
        // 键盘可达性（审查 🟡-8）：把手可聚焦（tabindex=0），
        // ←/→ 微调比例，Home/End 到最小/最大。WAI-ARIA separator 模式。
        this.handle.addEventListener("keydown", (e) => this.onKeydown(e));
    }

    /** 键盘调整：←/→ 步进 2%，Home/End 到 15%/85% 边界 */
    private onKeydown(e: KeyboardEvent): void {
        if (this.mode !== "both") return;
        let delta = 0;
        switch (e.key) {
            case "ArrowLeft": delta = -0.02; break;
            case "ArrowRight": delta = 0.02; break;
            case "Home": e.preventDefault(); this.setRatio(0.15); return;
            case "End": e.preventDefault(); this.setRatio(0.85); return;
            default: return;
        }
        e.preventDefault();
        this.setRatio(this.ratio + delta);
    }

    /** 设置比例（夹取到 0.15..0.85）并通知监听方 */
    private setRatio(r: number): void {
        this.ratio = _internal.clampRatio(r);
        this.applyRatio();
        this.onChange?.(this.ratio);
    }

    setMode(mode: SplitMode) {
        this.mode = mode;
        this.host.dataset.mode = mode;
    }

    getMode(): SplitMode {
        return this.mode;
    }

    getRatio(): number {
        return this.ratio;
    }

    private startDrag(e: PointerEvent) {
        if (this.mode !== "both") return;
        e.preventDefault();
        this.dragging = true;
        this.handle.setPointerCapture(e.pointerId);
        this.handle.classList.add("dragging");
        const onMove = (ev: PointerEvent) => this.onDrag(ev);
        const onUp = (ev: PointerEvent) => {
            this.dragging = false;
            this.handle.classList.remove("dragging");
            try { this.handle.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            this.onChange?.(this.ratio);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        // 审查 🟡-3：拖拽被系统打断（触屏手势冲突 / Alt-Tab）时派发的是
        // pointercancel 而非 pointerup。旧版只听 up：dragging 永真、
        // 监听器永久残留，此后鼠标一动分栏比例就跟着变（幽灵拖拽）。
        window.addEventListener("pointercancel", onUp);
    }

    private onDrag(e: PointerEvent) {
        if (!this.dragging) return;
        const rect = this.host.getBoundingClientRect();
        const x = e.clientX - rect.left;
        this.ratio = _internal.clampRatio(x / rect.width);
        this.applyRatio();
    }

    private applyRatio() {
        const pct = (this.ratio * 100).toFixed(2);
        this.host.style.setProperty("--split-ratio", pct + "%");
        // aria-valuenow 用整数百分比：拖动/键盘调整时屏幕阅读器播报友好
        this.handle.setAttribute("aria-valuenow", String(Math.round(this.ratio * 100)));
    }
}

/** 审计 R2 测试补强：导出钳位纯函数 + 构造校验消息常量。 */
export const _internal = {
    clampRatio: (r: number): number => Math.max(0.15, Math.min(0.85, r)),
    MISSING_CHILDREN_MSG: "SplitPane: host 缺少 .pane-left/.pane-right/.pane-handle 子元素",
};
