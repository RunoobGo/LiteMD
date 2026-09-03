// font-size.ts — 编辑区字号持久化（#11 P2 待办：字号跨会话保留）
//
// 与 theme 复用同一 localStorage 模式：启动时读 → CSS 变量驱动编辑区（editor.ts
// 引用 var(--md-fontsize)）；用户经由 setFontSize 调整时即时写回 localStorage。
// Go 侧 GetConfig/SetConfig 已存在但本版保留 localStorage 路径（前端频繁读写，
// 跨 Wails 边界序列化开销不值，主题一直如此；下一迭代再考虑统一到 Config）。
//
// 范围限定 10–24px（10 以下几乎不可读，24 以上需拖动滚动条，体验变差）。

export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 24;
export const DEFAULT_FONT_SIZE = 14;
const FONT_SIZE_KEY = "litemd:fontSize";

/** 读取持久化的字号；localStorage 不可用或值越界时回退默认。 */
export function getFontSize(): number {
    try {
        const raw = localStorage.getItem(FONT_SIZE_KEY);
        if (raw === null) return DEFAULT_FONT_SIZE;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < MIN_FONT_SIZE || n > MAX_FONT_SIZE) {
            return DEFAULT_FONT_SIZE;
        }
        return n;
    } catch {
        return DEFAULT_FONT_SIZE;
    }
}

/** 设置字号：钳位到合法范围 + 写 CSS 变量 + 持久化。返回最终生效值。 */
export function setFontSize(size: number): number {
    const n = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size)));
    document.documentElement.style.setProperty("--md-fontsize", `${n}px`);
    try {
        localStorage.setItem(FONT_SIZE_KEY, String(n));
    } catch { /* 隐私模式静默降级 */ }
    return n;
}

/** 启动时调用一次：把持久化值应用到 CSS 变量（不重复写 localStorage）。 */
export function applyInitialFontSize(): number {
    const n = getFontSize();
    document.documentElement.style.setProperty("--md-fontsize", `${n}px`);
    return n;
}
