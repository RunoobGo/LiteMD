// sidebar.test.ts — Sidebar 类单元测试（审计 R2 测试补强）
//
// 锁三类契约：
//   1. clamp 边界（min/max 截断 + 反向区间容错）；
//   2. setVisible / toggle 状态机（重复设同值不触发 onChange）；
//   3. localStorage 持久化（width 读回、visible 默认展开）。

import { Sidebar, _internal } from "./sidebar";
const { clamp } = _internal;

let pass = 0; let fail = 0;
function assertEq<T>(actual: T, expected: T, msg: string): void {
    if (actual === expected) {
        pass++;
        console.log("  ✓ " + msg);
    } else {
        fail++;
        console.log("  ✗ " + msg + ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
    }
}

function fresh(): { root: HTMLElement; el: HTMLElement; events: boolean[] } {
    const root = document.createElement("div");
    root.id = "app";
    const el = document.createElement("aside");
    el.className = "sidebar";
    const body = document.createElement("div");
    body.className = "sidebar-body";
    el.appendChild(body);
    root.appendChild(el);
    document.body.appendChild(root);
    const events: boolean[] = [];
    // 复位 localStorage（避免上一组测试残留）
    try { localStorage.removeItem("litemd:sidebar:width"); } catch { /* */ }
    try { localStorage.removeItem("litemd:sidebar:visible"); } catch { /* */ }
    return { root, el, events };
}

console.log("clamp 边界：");
assertEq(clamp(100, 0, 200), 100, "中间值透传");
assertEq(clamp(-10, 0, 200), 0, "低于下限截到下限");
assertEq(clamp(300, 0, 200), 200, "高于上限截到上限");
assertEq(clamp(0, 0, 200), 0, "等于下限透传");
assertEq(clamp(200, 0, 200), 200, "等于上限透传");
assertEq(clamp(150, 200, 0), 200, "反向区间（lo > hi）取 hi");

console.log("\nSidebar 构造：");
{
    const { root, el } = fresh();
    let changes = 0;
    const sb = new Sidebar(root, el, { defaultWidth: 240, onChange: () => changes++ });
    assertEq(sb.isVisible(), true, "默认展开");
    assertEq(sb.getWidth(), 240, "使用 defaultWidth");
    assertEq(root.dataset.sidebar, "on", "data-sidebar=on 写入");
    assertEq(root.style.getPropertyValue("--sidebar-w"), "240px", "--sidebar-w 写入");
    // 构造期 applyVisible(false) 会触发一次 onChange（实际不 persist）
    assertEq(changes, 1, "构造期 applyVisible 触发 1 次 onChange");
}

console.log("\nsetVisible 状态机：");
{
    const { root, el } = fresh();
    let changes = 0;
    const sb = new Sidebar(root, el, { onChange: () => changes++ });
    // 构造已 1 次
    sb.setVisible(false);
    assertEq(sb.isVisible(), false, "隐藏");
    assertEq(root.dataset.sidebar, "off", "data-sidebar=off 写入");
    assertEq(root.style.getPropertyValue("--sidebar-w"), "0px", "收起时 --sidebar-w=0");
    assertEq(changes, 2, "首次切隐藏再触发 onChange（构造 1 + 切 1）");
    sb.setVisible(false);
    assertEq(changes, 2, "重复 setVisible(false) 不再触发 onChange");
    sb.toggle();
    assertEq(sb.isVisible(), true, "toggle 切到展开");
    assertEq(changes, 3, "toggle 触发 onChange");
}

console.log("\nlocalStorage 持久化（读回）：");
{
    const { root, el } = fresh();
    try { localStorage.setItem("litemd:sidebar:width", "320"); } catch { /* */ }
    try { localStorage.setItem("litemd:sidebar:visible", "0"); } catch { /* */ }
    const sb = new Sidebar(root, el, {});
    assertEq(sb.getWidth(), 320, "持久化 width 读回");
    assertEq(sb.isVisible(), false, "持久化 visible=false 读回（收起）");
    // 越界值钳位
    try { localStorage.setItem("litemd:sidebar:width", "999"); } catch { /* */ }
    const sb3 = new Sidebar(root, el, { minWidth: 100, maxWidth: 200 });
    // 999 > maxWidth=200，应被钳到 200
    assertEq(sb3.getWidth(), 200, "持久化 width 越界被钳位");
    void root; // sb2 占位（构造期覆盖）已被 sb3 复用
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
