// unsaved-guard.ts — 关闭未保存拦截
//
// 提供两层保护：
//   - 关闭单个 tab 时弹出三选项（保存/放弃/取消）
//   - 应用级 beforeunload 拦截，提示用户先关闭未保存的 tab

import type { TabManager } from "./tabs";

export type UnsavedChoice = "save" | "discard" | "cancel";

/**
 * 弹出未保存对话框，返回用户决定。
 * 使用 <dialog> 元素（HTML 原生），支持 ESC 取消。
 */
export async function askUnsaved(fileName: string): Promise<UnsavedChoice> {
    const dlg = document.getElementById("unsavedDialog") as HTMLDialogElement;
    const nameEl = document.getElementById("unsavedFileName");
    if (nameEl) nameEl.textContent = fileName;
    if (!dlg.open) dlg.showModal();

    return new Promise<UnsavedChoice>((resolve) => {
        const handler = (_e: Event) => {
            // dialog close 事件：通过 dialog.returnValue 取得 button value（form method="dialog" 自动设置）
            const v = dlg.returnValue || "cancel";
            dlg.removeEventListener("close", handler);
            if (v === "save") resolve("save");
            else if (v === "discard") resolve("discard");
            else resolve("cancel");
        };
        dlg.addEventListener("close", handler, { once: true });
    });
}

/**
 * 安装应用级 beforeunload 拦截。
 * WebView2 默认支持 beforeunload，会弹原生确认。
 */
export function installBeforeUnloadGuard(tabManager: TabManager) {
    window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
        if (tabManager.hasAnyDirty()) {
            e.preventDefault();
            e.returnValue = "存在未保存的修改，确定关闭吗？";
            return e.returnValue;
        }
    });
}

// ============================================================================
// #3 修复：退出前协商（Wails v2 无 OnBeforeClose 异步协商，自绘关闭按钮
// 直调 Quit() 会静默丢弃全部未保存修改——beforeunload 在该路径不触发）
// ============================================================================

export type QuitChoice = "quit" | "cancel";

/**
 * 退出放行的纯决策函数（与 DOM 解耦，可单测）：
 *   - 无脏标签 → 直接放行（不弹窗打扰）
 *   - 有脏标签 → 仅当用户显式选择「退出」才放行；取消/ESC/关闭对话框均拦截
 */
export function quitDecision(hasDirty: boolean, choice: QuitChoice | null): boolean {
    if (!hasDirty) return true;
    return choice === "quit";
}

/**
 * 退出前协商：无脏直接放行；有脏弹 quitDialog 确认。
 * 返回 true 表示可以调用 Quit()。
 */
export async function confirmQuit(tabManager: TabManager): Promise<boolean> {
    if (!tabManager.hasAnyDirty()) return true;
    const dlg = document.getElementById("quitDialog") as HTMLDialogElement | null;
    // 兜底：对话框缺失（模板被改坏等）时拒绝退出，宁可不关也不能丢数据
    if (!dlg) return false;
    const hint = document.getElementById("quitHint");
    if (hint) hint.textContent = "关闭窗口将丢失未保存的内容。";
    if (!dlg.open) dlg.showModal();
    return new Promise<boolean>((resolve) => {
        const handler = () => {
            // dialog close：returnValue 由 form method="dialog" 的按钮 value 自动设置
            const v = dlg.returnValue || "cancel";
            dlg.removeEventListener("close", handler);
            resolve(quitDecision(true, v === "quit" ? "quit" : "cancel"));
        };
        dlg.addEventListener("close", handler, { once: true });
    });
}
