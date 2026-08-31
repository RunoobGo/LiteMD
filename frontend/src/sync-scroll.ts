// sync-scroll.ts — 编辑器 / 预览 分屏同步滚动
//
// 锚点机制：preview.ts 为每个顶层块注入 data-line（源 markdown 行号），
// 编辑器侧直接用 CodeMirror 行块。双向同步均基于「锚点 + 线性插值」：
// 视口顶落在两个锚点之间时按比例插值，滚动手感连续而非块级跳动。
//
// 防回环：程序化滚动会触发对侧的 scroll 事件，若不加防护会形成
// 滚动事件乒乓。**锁必须分侧**：写预览时只锁预览侧、写编辑器时只锁
// 编辑器侧——源侧（用户正在滚的那边）的事件永不被屏蔽，否则连续
// 滚轮的后续步进会被吞掉（12 步只同步 4 步的成因）。

import type { MarkdownEditor } from "./editor";

/** 采集预览面板内的行号锚点（按文档顺序） */
interface Anchor {
    line: number; // 源行号（1-based）
    top: number;  // 相对预览滚动内容顶部的偏移（px）
}

/** 锁窗口：一次程序化滚动引发的连锁 scroll 事件在其内被忽略 */
const LOCK_MS = 150;

export class SyncScroll {
    private enabled = true;
    /** 分屏模式为 both 时两侧同时可见，才有同步的意义 */
    private active = true;
    /** 分侧锁：仅在程序化写入该侧后短暂屏蔽该侧事件（抑制回声） */
    private lockPreviewUntil = 0;
    private lockEditorUntil = 0;

    constructor(
        private editor: MarkdownEditor,
        private previewEl: HTMLElement,
    ) {
        editor.getScrollDOM().addEventListener("scroll", () => {
            if (!this.canSync()) return;
            if (Date.now() < this.lockEditorUntil) return;
            this.syncFromEditor();
        });
        previewEl.addEventListener("scroll", () => {
            if (!this.canSync()) return;
            if (Date.now() < this.lockPreviewUntil) return;
            this.syncFromPreview();
        });
    }

    /** 同步开关（工具栏按钮切换） */
    setEnabled(v: boolean) {
        this.enabled = v;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** 视图模式变化：仅 both 模式激活（单栏无从同步） */
    setActive(v: boolean) {
        this.active = v;
    }

    private canSync(): boolean {
        return this.enabled && this.active;
    }

    /** 编辑器 → 预览：按视口顶行号定位预览滚动位置 */
    private syncFromEditor() {
        const line = this.editor.getTopLine();
        const anchors = this.collectAnchors();
        if (!anchors.length) return;
        this.lockPreviewUntil = Date.now() + LOCK_MS;
        this.previewEl.scrollTop = this.interpolate(anchors, line);
    }

    /** 预览 → 编辑器：按预览滚动位置定位编辑器行 */
    private syncFromPreview() {
        const anchors = this.collectAnchors();
        if (!anchors.length) return;
        const top = this.previewEl.scrollTop;
        let line: number;
        if (top <= anchors[0].top) {
            line = 1; // 第一个锚点上方（预览顶部 padding 区）
        } else if (top >= anchors[anchors.length - 1].top) {
            line = anchors[anchors.length - 1].line; // 最后一个锚点及以下
        } else {
            // 找 top 所在的锚点区间，线性插值出行号
            let lo = 0;
            let hi = anchors.length - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (anchors[mid].top <= top) lo = mid; else hi = mid;
            }
            const a = anchors[lo];
            const b = anchors[hi];
            const ratio = (top - a.top) / Math.max(1, b.top - a.top);
            line = a.line + ratio * (b.line - a.line);
        }
        this.lockEditorUntil = Date.now() + LOCK_MS;
        this.editor.scrollToLine(Math.round(line));
    }

    /** 收集预览面板的 data-line 锚点（文档顺序，top 为内容坐标） */
    private collectAnchors(): Anchor[] {
        const out: Anchor[] = [];
        // 内容坐标换算：内容坐标 = 视口坐标 - 容器视口顶 + 当前 scrollTop。
        // 注意是 **加** scrollTop（滚动后元素在视口上移、内容坐标不变）。
        // 旧版误写成减号：scrollTop=0 时碰巧正确，一旦滚动中收集，
        // 所有锚点偏小 2×scrollTop → 反向同步过冲 / 正向同步倒退。
        const viewTop = this.previewEl.getBoundingClientRect().top;
        const scrollTop = this.previewEl.scrollTop;
        this.previewEl.querySelectorAll<HTMLElement>("[data-line]").forEach((el) => {
            const line = parseInt(el.dataset.line || "", 10);
            if (!Number.isFinite(line) || line < 1) return;
            out.push({ line, top: el.getBoundingClientRect().top - viewTop + scrollTop });
        });
        return out;
    }

    /** 行号 → 预览内容坐标（锚点间线性插值；超出首尾锚点用相邻区间外推） */
    private interpolate(anchors: Anchor[], line: number): number {
        if (line <= anchors[0].line) {
            const next = anchors[1] ?? anchors[0];
            const ratio = (line - anchors[0].line) / Math.max(1, next.line - anchors[0].line);
            return anchors[0].top + ratio * (next.top - anchors[0].top);
        }
        for (let i = 0; i < anchors.length - 1; i++) {
            const a = anchors[i];
            const b = anchors[i + 1];
            if (line <= b.line) {
                const ratio = (line - a.line) / Math.max(1, b.line - a.line);
                return a.top + ratio * (b.top - a.top);
            }
        }
        // 超出最后一个锚点：沿用最后区间的斜率外推
        const last = anchors[anchors.length - 1];
        const prev = anchors[anchors.length - 2] ?? last;
        const ratio = (line - last.line) / Math.max(1, last.line - prev.line);
        return last.top + ratio * (last.top - prev.top);
    }
}
