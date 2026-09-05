// env.test.ts — 运行形态判定单测（审计 R2-F7 / v0.2.11 修正）
//
// 锁定的契约：调试句柄（__litemd__bindings / __litemd__cm 等）的暴露与否
// 只取决于「有没有 Wails 运行时」，与构建模式（DEV/PROD）无关。
//
// 背景：R2-F7 初版用 import.meta.env.DEV 守门，而 E2E 跑在 vite preview
// 服务的生产产物上（DEV 恒为 false），导致调试句柄在 E2E 中整体消失。

import { isWailsRuntime, exposeDebugHandles } from "./env";

let pass = 0;
let fail = 0;
function assertEq<T>(actual: T, expected: T, msg: string): void {
    if (actual === expected) {
        pass++;
        console.log("  ✓ " + msg);
    } else {
        fail++;
        console.log(`  ✗ ${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
    }
}

const hadRuntime = Object.prototype.hasOwnProperty.call(window as any, "runtime");
const origRuntime = (window as any).runtime;
function restore(): void {
    if (hadRuntime) (window as any).runtime = origRuntime;
    else delete (window as any).runtime;
}

console.log("运行形态判定（env.ts）：");
{
    // 1) 浏览器 / E2E 形态（含 vite preview 服务的生产产物）
    delete (window as any).runtime;
    assertEq(isWailsRuntime(), false, "无 window.runtime → 非 Wails 桌面环境");
    assertEq(exposeDebugHandles(), true, "非 Wails 环境 → 暴露调试句柄");
}
{
    // 2) 真实桌面 App 形态：Wails 注入 window.runtime
    (window as any).runtime = { LogPrint() {}, EventsOn() {}, Quit() {} };
    assertEq(isWailsRuntime(), true, "有 window.runtime 对象 → Wails 桌面环境");
    assertEq(exposeDebugHandles(), false, "Wails 桌面环境 → 不暴露调试句柄（R2-F7 原始诉求）");
}
{
    // 3) 防御：runtime 为 null / 非对象不应被误判为桌面环境，
    //    否则调试句柄会被静默吞掉，E2E 再次失去抓手。
    (window as any).runtime = null;
    assertEq(isWailsRuntime(), false, "runtime=null → 非 Wails 环境（防御）");
    assertEq(exposeDebugHandles(), true, "runtime=null → 仍暴露调试句柄");
    (window as any).runtime = "truthy-but-not-object";
    assertEq(isWailsRuntime(), false, "runtime 非对象 → 非 Wails 环境（防御）");
    (window as any).runtime = 0;
    assertEq(isWailsRuntime(), false, "runtime=0 → 非 Wails 环境（防御）");
}
restore();

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
