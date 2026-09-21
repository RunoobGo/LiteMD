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
    const dlg = document.getElementById("unsavedDialog") as HTMLDialogElement | null;
    // 与 confirmOverwrite / confirmQuit 同口径：对话框缺失（模板被改坏）时
    // 按"取消"处理。此前本函数直接 `dlg.returnValue = ""` 无判空，模板一旦
    // 改动就抛 TypeError，关闭流程被打断在未保存数据的中途——返回 cancel
    // 至少让数据留在原地。
    if (!dlg) return "cancel";
    const nameEl = document.getElementById("unsavedFileName");
    if (nameEl) nameEl.textContent = fileName;
    // 关键：ESC 关闭对话框不修改 returnValue，它残留上一次按钮写入的值——
    // 连续关闭第二个未保存标签时按 ESC 会“复用”上次的选择（如「放弃修改」），
    // 造成静默丢数据。必须在每次 showModal 前显式清零（审查 🔴-2）。
    dlg.returnValue = "";
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
// #3 修复：退出前协商（OnBeforeClose 是 Go 侧同步原生框，只兜底 OS 级关闭
// 路径 Alt+F4/Cmd+Q；自绘关闭按钮走这里的前端 quitDialog 异步协商，
// 放行序列见文件末尾 requestQuit）
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
 * 外部修改冲突确认（P0-5）：磁盘文件的 mtime 与记账不符时弹出。
 * 返回 true 表示用户选择「覆盖外部修改」；false / ESC / 关闭 = 取消。
 */
export async function confirmOverwrite(fileName: string): Promise<boolean> {
    const dlg = document.getElementById("overwriteDialog") as HTMLDialogElement | null;
    // 对话框缺失（模板被改坏）时拒绝覆盖，宁可不保存也不能静默覆盖外部修改
    if (!dlg) return false;
    const hint = document.getElementById("overwriteHint");
    if (hint) hint.textContent = `${fileName} 在打开后被其他程序修改过。继续保存将覆盖磁盘上的内容，是否覆盖？`;
    // 与 askUnsaved 同源：ESC 残留 returnValue 会导致复用上次选择
    dlg.returnValue = "";
    if (!dlg.open) dlg.showModal();
    return new Promise<boolean>((resolve) => {
        const handler = () => {
            const v = dlg.returnValue || "cancel";
            dlg.removeEventListener("close", handler);
            resolve(v === "overwrite");
        };
        dlg.addEventListener("close", handler, { once: true });
    });
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
    // 与 askUnsaved 同源：ESC 残留上次的 "quit" 会导致按 ESC 直接退出丢数据
    dlg.returnValue = "";
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

// ============================================================================
// requestQuit — 标题栏关闭按钮的完整放行序列
// ============================================================================

/** requestQuit 的副作用依赖（main.ts 注入，避免本模块直接 import wailsjs） */
export interface QuitFlowDeps {
    /** 把 Go 侧未保存计数上报清零（SetUnsavedCount(0)） */
    clearUnsaved(): Promise<void>;
    /** Wails runtime.Quit() */
    quit(): void;
}

/**
 * 关闭序列：前端协商（confirmQuit）→ 未保存计数清零 → Quit()。
 *
 * 清零一步不可省：Wails v2.14 的 Quit() 会同步调用 OnBeforeClose
 * （internal/frontend/desktop/windows/frontend.go Quit），Go 侧计数 >0
 * 会再弹一次原生确认框——用户在前端对话框已选「退出」仍被二次追问。
 * 清零失败（IPC 异常）兜底继续 Quit()：最坏退回一次原生确认框，
 * 不能让关闭按钮变成无响应。
 */
export async function requestQuit(tabManager: TabManager, deps: QuitFlowDeps): Promise<void> {
    if (!(await confirmQuit(tabManager))) return;
    try {
        await deps.clearUnsaved();
    } catch {
        /* 计数上报失败不阻塞退出，见上文兜底说明 */
    }
    deps.quit();
}
