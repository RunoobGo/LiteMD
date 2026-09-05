/**
 * 运行形态判定：当前页面跑在真实 Wails 桌面环境，还是浏览器 / E2E 环境。
 *
 * ## 为什么不用 `import.meta.env.DEV`
 *
 * 审计 R2-F7 曾给 `window.__litemd__bindings` 加上 `import.meta.env.DEV`
 * 守门，意图是"生产构建不泄漏调试句柄"。但全部 E2E sprint 都跑在
 * `vite preview --port 5174` 服务的**生产构建产物**上（`DEV` 被静态替换为
 * `!1`），dev.html 与 index.html 共用同一份 bundle，换入口页并不能让 DEV
 * 变回 true——结果是 `sprint1.sh` 等脚本依赖的调试句柄在生产产物下整体消失，
 * E2E 硬断言必挂。
 *
 * 真正的区分维度不是"构建模式"，而是**"有没有 Wails 运行时"**：
 *   - 真实桌面 App：Wails 注入 `window.runtime`（见 wailsjs/runtime/runtime.js
 *     与 main.ts 既有的 `(window as any).runtime` 判据）→ 不暴露调试句柄；
 *   - 浏览器 / E2E（vite dev、vite preview、agent-browser）→ 暴露。
 *
 * 这样既满足 R2-F7"产线不泄漏"的诉求，又与 vite preview 完全兼容。
 */

/**
 * 是否运行在真实 Wails 桌面环境。
 *
 * 判定依据是 Wails 注入的全局 `window.runtime` 对象，与 `main.ts` 中
 * 图片落盘分支、无边框控制按钮的两处既有判据保持同一口径。
 */
export function isWailsRuntime(): boolean {
    if (typeof window === "undefined") return false;
    const rt = (window as any).runtime;
    return typeof rt === "object" && rt !== null;
}

/**
 * 是否应当把调试 / E2E 句柄挂到 window 上。
 *
 * 真实桌面环境一律不挂；浏览器与 E2E（**含 vite preview 生产产物**）一律挂。
 */
export function exposeDebugHandles(): boolean {
    return !isWailsRuntime();
}
