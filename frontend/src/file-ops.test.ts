// file-ops.test.ts — bind() fallback 链单元测试（审计 R2 测试补强）
//
// 锁三类契约：
//   1. window.go.main.App[name] 存在时优先用 mock（浏览器/E2E）；
//   2. mock 缺位时回退到 wailsjs/go/main/App 真实 binding（桌面端）；
//   3. 两者都缺时 throw（让 caller 知道 binding 不可用）。
//
// 注意：本文件只测试 bind 的优先级，不测试各 binding 的具体行为
// （那些由 E2E + Wails runtime 验证）。

import { bind } from "./file-ops";
import { isWailsRuntime, exposeDebugHandles } from "./env";

let pass = 0;
let fail = 0;
function assert(cond: unknown, msg: string): void {
    if (cond) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg); }
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
    if (actual === expected) {
        pass++;
        console.log("  ✓ " + msg);
    } else {
        fail++;
        console.log("  ✗ " + msg + ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
    }
}
function assertThrows(fn: () => void, expectedMatch: RegExp, msg: string): void {
    try {
        fn();
        fail++;
        console.log("  ✗ " + msg + " (no throw)");
    } catch (e: any) {
        if (expectedMatch.test(String(e?.message ?? ""))) {
            pass++;
            console.log("  ✓ " + msg);
        } else {
            fail++;
            console.log("  ✗ " + msg + ` (threw "${e?.message}", want match ${expectedMatch})`);
        }
    }
}

// 备份 + 还原 window.go，避免污染其他测试
const origGo = (window as any)?.go;
function setupWindow(opts: { mockApp?: Record<string, unknown> }): void {
    (window as any).go = opts.mockApp ? { main: { App: opts.mockApp } } : undefined;
    (globalThis as any).go = (window as any).go;
}
function teardownWindow(): void {
    (window as any).go = origGo;
    (globalThis as any).go = origGo;
}

console.log("bind 优先级：");
{
    // 1) mock 优先：bind() 应返回 mock 函数，调用 +1。
    let mockCalls = 0;
    setupWindow({
        mockApp: {
            OpenFile: () => { mockCalls++; return "mock-result"; },
        },
    });
    const fn = bind("OpenFile");
    assertEq(typeof fn, "function", "mock 存在时 bind 返回 function");
    const r = fn("p");
    assertEq(mockCalls, 1, "mock OpenFile 命中一次（同步路径）");
    assertEq(r, "mock-result", "mock 返回值透传");
    teardownWindow();
}
{
    // 2) mock 缺位 → 回退到 wailsBindings（静态 import）。生产环境
    // 下 wailsBindings 来自 wailsjs/go/main/App，是 wails CLI 生成的
    // 真实 binding。tsx 加载时该模块会被解析——但运行时实际执行
    // `window.go.main.App[name](arg)`，需要 window.go 设置才能跑通。
    // 这里给 wailsBindings 装一个 window.go 真 mock 验证 fallback 路径
    // 真的"被选中"（即不是 mock 命中）。
    setupWindow({
        mockApp: {}, // 模拟 mock 存在但 OpenFile 不在
    });
    // 同时让 wailsBindings 内部 `window.go.main.App.OpenFile` 走通
    (window as any).go = { main: { App: { OpenFile: () => "wails-result" } } };
    (globalThis as any).go = (window as any).go;
    try {
        const r = bind("OpenFile");
        assert(typeof r === "function", "mock 不含 OpenFile 时回退到真实 binding");
        const got = r("p");
        assertEq(got, "wails-result", "fallback 路径真的命中 wails binding");
    } catch (e) {
        // wailsjs/go/main/App 在 tsx 加载时若不存在，bind 会抛
        fail++;
        console.log("  ✗ 回退真实 binding 失败：" + String(e));
    }
    teardownWindow();
}
{
    // 3) 两者都缺 → throw
    setupWindow({});
    assertThrows(() => bind("NonExistentBinding_xyz"), /not available/, "mock + 真实都缺时 throw");
    teardownWindow();
}

console.log("\n__litemd__bindings Wails 运行时守门（审计 R2-F7 / v0.2.11 修正）：");
{
    // v0.2.11 起守门条件由 import.meta.env.DEV 改为「是否存在 Wails 运行时」。
    // 原因：E2E 跑在 vite preview 服务的生产产物上，DEV 恒为 false，旧守门
    // 会让调试句柄在 E2E 中整体消失（sprint1.sh 的 bindings.SaveFile 断言挂）。
    // tsx 单测环境没有 window.runtime，等价于浏览器 / E2E 形态 → 应注入。
    assertEq(isWailsRuntime(), false, "单测环境无 window.runtime → 非 Wails 桌面环境");
    assertEq(exposeDebugHandles(), true, "非 Wails 环境 → 应暴露调试句柄");
    const w = (window as any).__litemd__bindings;
    assert(typeof w === "object" && w !== null, "无 Wails 运行时，bindings 已注入 window");
    assertEq(typeof w?.OpenFile, "function", "OpenFile binding 可调用");
    assertEq(typeof w?.SaveFile, "function", "SaveFile binding 可调用");
    assertEq(typeof w?.CopyImageAsset, "function", "CopyImageAsset binding 可调用");
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
