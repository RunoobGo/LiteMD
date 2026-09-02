// html.ts — HTML 转义（唯一事实源）
//
// 审查 🟡-6：此前 main.ts 与 latex.ts 各持一份 escapeHtml 实现，字符集
// 相同纯属巧合维护，修一处漏一处是大概率事件。obsidian.ts（callout
// 相关）与未来调用方统一 import 本函数。

export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    }[c]!));
}
