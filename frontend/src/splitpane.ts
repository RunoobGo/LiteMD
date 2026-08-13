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
            throw new Error("SplitPane: host 缺少 .pane-left/.pane-right/.pane-handle 子元素");
        }

        this.applyRatio();

        this.handle.addEventListener("pointerdown", (e) => this.startDrag(e));
        // 同时处理双击：重置比例
        this.handle.addEventListener("dblclick", () => {
            this.ratio = 0.5;
            this.applyRatio();
            this.onChange?.(this.ratio);
        });
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
            this.onChange?.(this.ratio);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }

    private onDrag(e: PointerEvent) {
        if (!this.dragging) return;
        const rect = this.host.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const ratio = Math.max(0.15, Math.min(0.85, x / rect.width));
        this.ratio = ratio;
        this.applyRatio();
    }

    private applyRatio() {
        const pct = (this.ratio * 100).toFixed(2);
        this.host.style.setProperty("--split-ratio", pct + "%");
    }
}
