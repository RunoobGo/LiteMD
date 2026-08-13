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
