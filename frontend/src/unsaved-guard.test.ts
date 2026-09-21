// unsaved-guard.test.ts — 关闭/覆盖协商的单测（审查 2026-09-18 补强）
//
// 三件事：
//   1. quitDecision 纯决策：无脏直接放行，有脏只在显式「退出」时放行，
//      ESC / 关闭对话框（choice=null 或非 quit）一律拦截；
//   2. 对话框缺失时的失效安全方向：askUnsaved → "cancel"、
//      confirmOverwrite → false、confirmQuit → false（宁可不关也不能丢数据）；
//   3. showModal 前清零 returnValue：ESC 关闭不修改 returnValue，残留上一
//      次的选择会造成「第二次按 ESC 静默丢数据」（审查 🔴-2）；
//   4. requestQuit 放行序列：前端协商通过后必须先把 Go 侧未保存计数清零
//      再 Quit()——Wails v2.14 的 Quit() 同步调用 OnBeforeClose，计数 >0
//      会再弹一次原生确认框（双重确认 bug）。
//
// 注：askUnsaved 原缺判空（直接 dlg.returnValue = ""），模板改坏即抛
// TypeError；本套件第 2 组即该缺陷的回归。

import { askUnsaved, confirmOverwrite, confirmQuit, quitDecision, requestQuit } from "./unsaved-guard";

let pass = 0;
let fail = 0;
function assertEq<T>(actual: T, expected: T, msg: string): void {
    if (actual === expected) {
        pass++;
        console.log("  ✓ " + msg);
    } else {
        fail++;
        console.log("  ✗ " + msg + ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
    }
}

/**
 * 建一个 <dialog> 并补上 jsdom 未实现的 showModal / close。
 *
 * jsdom（截至 29.x）只实现了 <dialog> 的 open 属性，showModal() 与
 * close(returnValue) 缺失——生产代码在真实 WebView2 里跑的是原生实现，
 * 这里按规范语义打桩：showModal 置 open、close 写入 returnValue 并派发
 * close 事件（被测逻辑只依赖这两个行为）。
 */
function makeDialog(id: string): HTMLDialogElement {
    document.body.innerHTML = `<dialog id="${id}">
        <form method="dialog">
            <button id="btn-${id}" value="yes">确定</button>
        </form>
    </dialog>`;
    const dlg = document.getElementById(id) as HTMLDialogElement;
    (dlg as any).showModal = function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
    };
    (dlg as any).close = function (this: HTMLDialogElement, v?: string) {
        if (v !== undefined) this.returnValue = v;
        this.removeAttribute("open");
        this.dispatchEvent(new Event("close"));
    };
    return dlg;
}

console.log("\nquitDecision 纯决策：");
assertEq(quitDecision(false, null), true, "无脏标签 → 直接放行（不打扰用户）");
assertEq(quitDecision(true, "quit"), true, "有脏 + 显式退出 → 放行");
assertEq(quitDecision(true, "cancel"), false, "有脏 + 取消 → 拦截");
assertEq(quitDecision(true, null), false, "有脏 + 无选择（ESC/关闭对话框）→ 拦截");

console.log("\n对话框缺失时的失效安全方向：");
document.body.innerHTML = ""; // 清空模板，模拟 index.html 被改坏
void (async () => {
    assertEq(await askUnsaved("a.md"), "cancel" as const, "askUnsaved 无对话框 → cancel（不抛错）");
    assertEq(await confirmOverwrite("a.md"), false, "confirmOverwrite 无对话框 → false（拒绝覆盖）");
    const fakeTabs = { hasAnyDirty: () => true } as any;
    assertEq(await confirmQuit(fakeTabs), false, "confirmQuit 无对话框 → false（拒绝退出）");

    console.log("\nreturnValue 残留清零（ESC 不误选上次结果）：");
    const dlg = makeDialog("unsavedDialog");
    // 预置"上次"的选择残留：不清零的话 ESC 关闭会复用它
    dlg.returnValue = "save";
    const pending = askUnsaved("a.md");
    assertEq(dlg.returnValue, "", "showModal 前 returnValue 已清零");
    dlg.close("discard"); // 模拟用户点「放弃修改」
    assertEq(await pending, "discard" as const, "按钮 value=discard → 返回 discard");

    // 再走一轮：印证清零是按次生效，第二次 ESC 不会复用上次的 discard
    const dlg2 = makeDialog("unsavedDialog");
    dlg2.returnValue = "discard";
    const pending2 = askUnsaved("b.md");
    assertEq(dlg2.returnValue, "", "第二轮同样清零");
    dlg2.close(""); // ESC 关闭：returnValue 为空
    assertEq(await pending2, "cancel" as const, "ESC 关闭（returnValue 空）→ cancel，不复用上次选择");

    console.log("\nrequestQuit 放行序列（防 OnBeforeClose 双弹窗）：");
    const cleanTm = { hasAnyDirty: () => false } as any;
    const dirtyTm = { hasAnyDirty: () => true } as any;
    {
        // 无脏：不打扰用户，但 Quit() 前计数仍须清零归位（幂等保险）
        const seq: string[] = [];
        await requestQuit(cleanTm, {
            clearUnsaved: async () => { seq.push("clear"); },
            quit: () => { seq.push("quit"); },
        });
        assertEq(seq.join(","), "clear,quit", "无脏 → 清零先于 Quit()");
    }
    {
        const dlg = makeDialog("quitDialog");
        const seq: string[] = [];
        const p = requestQuit(dirtyTm, {
            clearUnsaved: async () => { seq.push("clear"); },
            quit: () => { seq.push("quit"); },
        });
        assertEq(seq.length, 0, "对话框未决时不清零、不退出");
        dlg.close("quit"); // 用户点「退出（放弃修改）」
        await p;
        assertEq(seq.join(","), "clear,quit", "有脏 + 确认退出 → 计数清零后 Quit()（原生框不再弹）");
    }
    {
        const dlg = makeDialog("quitDialog");
        const seq: string[] = [];
        const p = requestQuit(dirtyTm, {
            clearUnsaved: async () => { seq.push("clear"); },
            quit: () => { seq.push("quit"); },
        });
        dlg.close("cancel");
        await p;
        assertEq(seq.join(","), "", "有脏 + 取消 → 不清零也不退出");
    }
    {
        // 清零 IPC 失败（绑定层异常等）：仍须退出，宁可退回一次原生确认，
        // 不能让关闭按钮变成无响应
        const seq: string[] = [];
        await requestQuit(cleanTm, {
            clearUnsaved: async () => { throw new Error("ipc down"); },
            quit: () => { seq.push("quit"); },
        });
        assertEq(seq.join(","), "quit", "清零失败仍调用 Quit()（关闭按钮不失效）");
    }

    console.log(`\n结果：${pass} 通过，${fail} 失败`);
    if (fail > 0) process.exit(1);
})();
