// splitpane.test.ts — SplitPane 类单元测试（审计 R2 测试补强）
//
// 锁四类契约：
//   1. 构造期 host 必须有 .pane-left/.pane-right/.pane-handle 三子元素；
//   2. ratio 边界：0.15..0.85 钳位；
//   3. mode 切换：data-mode 写入 + 拖拽/键盘 onlyBoth 守卫；
//   4. 双击复位到 0.5。

import { SplitPane, _internal } from "./splitpane";
const { clampRatio } = _internal;

let pass = 0; let fail = 0;
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

function makeHost(): HTMLElement {
    const host = document.createElement("div");
    host.className = "splitpane";
    host.innerHTML = `
        <div class="pane-left"></div>
        <div class="pane-right"></div>
        <div class="pane-handle" tabindex="0" role="separator"></div>
    `;
    document.body.appendChild(host);
    return host;
}

console.log("clampRatio 边界：");
assertEq(clampRatio(0.5), 0.5, "中间值透传");
assertEq(clampRatio(0.15), 0.15, "等于下限透传");
assertEq(clampRatio(0.85), 0.85, "等于上限透传");
assertEq(clampRatio(0.1), 0.15, "低于下限钳到 0.15");
assertEq(clampRatio(0.9), 0.85, "高于上限钳到 0.85");
assertEq(clampRatio(-0.1), 0.15, "负值钳到 0.15");
assertEq(clampRatio(1.5), 0.85, "超出 1 钳到 0.85");

console.log("\n构造：");
{
    const host = makeHost();
    const sp = new SplitPane(host, { initialRatio: 0.6 });
    assertEq(sp.getMode(), "both", "默认 both 模式");
    assertEq(sp.getRatio(), 0.6, "initialRatio 生效");
    assertEq(host.dataset.mode, "both", "data-mode=both 写入（默认）");
    assert(host.style.getPropertyValue("--split-ratio") === "60.00%", "CSS 变量 60% 写入");
    const handle = host.querySelector(".pane-handle") as HTMLElement;
    assertEq(handle.getAttribute("aria-valuenow"), "60", "aria-valuenow 整数百分比");
}

console.log("\n构造校验：");
{
    const host = document.createElement("div");
    host.innerHTML = "<div class='pane-left'></div>"; // 缺 .pane-right / .pane-handle
    document.body.appendChild(host);
    let threw = false;
    try { new SplitPane(host, {}); } catch { threw = true; }
    assert(threw, "缺子元素应 throw");
}

console.log("\nsetMode：");
{
    const host = makeHost();
    const sp = new SplitPane(host, {});
    sp.setMode("left");
    assertEq(sp.getMode(), "left", "mode=left");
    assertEq(host.dataset.mode, "left", "data-mode=left 写入");
    sp.setMode("right");
    assertEq(sp.getMode(), "right", "mode=right");
    sp.setMode("both");
    assertEq(sp.getMode(), "both", "mode=both 恢复");
}

console.log("\nonChange 回调：");
{
    const host = makeHost();
    let changes: number[] = [];
    const sp = new SplitPane(host, { onChange: (r) => changes.push(r) });
    // 模拟键盘 ← 步进
    const handle = host.querySelector(".pane-handle") as HTMLElement;
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft" });
    handle.dispatchEvent(event);
    assertEq(changes.length, 1, "← 触发一次 onChange");
    assertEq(changes[0], 0.48, "← 比例 -0.02 = 0.48");
    // 再次 →
    const ev2 = new KeyboardEvent("keydown", { key: "ArrowRight" });
    handle.dispatchEvent(ev2);
    assertEq(changes.length, 2, "→ 触发一次 onChange");
    assertEq(changes[1], 0.5, "→ 比例 +0.02 = 0.5");
    // Home → 0.15
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    assertEq(changes[changes.length - 1], 0.15, "Home 到 0.15");
    // End → 0.85
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    assertEq(changes[changes.length - 1], 0.85, "End 到 0.85");
    // 连按 ← 多次到下限以下，应被钳
    for (let i = 0; i < 100; i++) handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    assertEq(sp.getRatio(), 0.15, "← 连按 100 次仍 ≥ 0.15（钳位）");
}

console.log("\n非 both 模式下键盘不响应：");
{
    const host = makeHost();
    let changes = 0;
    const sp = new SplitPane(host, { onChange: () => changes++ });
    sp.setMode("left");
    const handle = host.querySelector(".pane-handle") as HTMLElement;
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    assertEq(changes, 0, "mode=left 时 ← 不触发 onChange");
    assertEq(sp.getRatio(), 0.5, "ratio 不变");
}

console.log("\n双击复位：");
{
    const host = makeHost();
    let changes: number[] = [];
    const sp = new SplitPane(host, { initialRatio: 0.7, onChange: (r) => changes.push(r) });
    const handle = host.querySelector(".pane-handle") as HTMLElement;
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    assertEq(sp.getRatio(), 0.5, "双击复位到 0.5");
    assertEq(changes[changes.length - 1], 0.5, "双击触发 onChange(0.5)");
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
