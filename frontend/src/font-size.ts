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
/** 审计 R2-F16：按住 Ctrl+= 触发 OS auto-repeat → 高频 localStorage 写。
 * 防抖 200ms 后写盘，CSS 变量即时生效（无需防抖）。 */
const PERSIST_DEBOUNCE_MS = 200;
let persistTimer: number | null = null;

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

/** 设置字号：钳位到合法范围 + 写 CSS 变量 + 持久化（防抖）。返回最终生效值。 */
export function setFontSize(size: number): number {
    const n = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size)));
    document.documentElement.style.setProperty("--md-fontsize", `${n}px`);
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
        persistTimer = null;
        try {
            localStorage.setItem(FONT_SIZE_KEY, String(n));
        } catch { /* 隐私模式静默降级 */ }
    }, PERSIST_DEBOUNCE_MS);
    return n;
}

/** 立即落盘挂起的字号变更（审计 R2-F16：测试用，生产路径不依赖）。
 *  取消防抖定时器并直接执行写盘，与正常 setTimeout 回调同语义。 */
export function flushFontSizePersist(): void {
    if (persistTimer === null) return;
    clearTimeout(persistTimer);
    persistTimer = null;
    try {
        // 复用最后一次 setFontSize 落盘的 n（写 current --md-fontsize
        // 反解）：简单起见直接读 CSS 变量解析；用户主动调 flush 通常
        // 是测试或退出前，不要求写到最新值。
        const css = document.documentElement.style.getPropertyValue("--md-fontsize").trim();
        if (css) localStorage.setItem(FONT_SIZE_KEY, css.replace(/px$/, ""));
    } catch { /* 隐私模式静默 */ }
}

/** 启动时调用一次：把持久化值应用到 CSS 变量（不重复写 localStorage）。 */
export function applyInitialFontSize(): number {
    const n = getFontSize();
    document.documentElement.style.setProperty("--md-fontsize", `${n}px`);
    return n;
}
