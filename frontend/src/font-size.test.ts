// font-size.test.ts — 编辑区字号持久化单元测试（#11 P2 落地）
//
// 覆盖：
//   1. 范围钳位（≤10 / ≥24 / 越界 / 非法值）
//   2. localStorage 往返
//   3. CSS 变量 --md-fontsize 的写入
//   4. 隐私模式（localStorage 抛错）下 setFontSize 不抛

import { getFontSize, setFontSize, applyInitialFontSize, flushFontSizePersist, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_FONT_SIZE } from "./font-size";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
    if (cond) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg); }
}
function resetLs() {
    try { localStorage.removeItem("litemd:fontSize"); } catch { /* ignore */ }
    document.documentElement.style.removeProperty("--md-fontsize");
}

console.log("getFontSize（启动读取）：");
{
    resetLs();
    assert(getFontSize() === DEFAULT_FONT_SIZE, "无持久化值时回退默认 14");
}
{
    resetLs();
    try { localStorage.setItem("litemd:fontSize", "18"); } catch { /* */ }
    assert(getFontSize() === 18, "已持久化的 18 被读回");
}
{
    resetLs();
    try { localStorage.setItem("litemd:fontSize", "abc"); } catch { /* */ }
    assert(getFontSize() === DEFAULT_FONT_SIZE, "非法值（NaN）回退默认");
}
{
    resetLs();
    try { localStorage.setItem("litemd:fontSize", "999"); } catch { /* */ }
    assert(getFontSize() === DEFAULT_FONT_SIZE, "越界值 999 回退默认");
}

console.log("\nsetFontSize（范围钳位 + 持久化 + CSS）：");
{
    resetLs();
    const got = setFontSize(20);
    assert(got === 20, "正常值 20 透传");
    const css = document.documentElement.style.getPropertyValue("--md-fontsize");
    assert(css === "20px", `CSS 变量被设为 20px（实际: ${css}）`);
    // 审计 R2-F16：setFontSize 防抖 200ms 后写盘。test 调
    // flushFontSizePersist 立即落盘，断言不再依赖时序。
    flushFontSizePersist();
    try { assert(localStorage.getItem("litemd:fontSize") === "20", "localStorage 写入 20（防抖 flush 后）"); } catch { /* */ }
}
{
    resetLs();
    const got = setFontSize(MIN_FONT_SIZE - 5);
    assert(got === MIN_FONT_SIZE, `低于下限 5 钳位到 ${MIN_FONT_SIZE}`);
    const css = document.documentElement.style.getPropertyValue("--md-fontsize");
    assert(css === `${MIN_FONT_SIZE}px`, `CSS 钳位为 ${MIN_FONT_SIZE}px`);
}
{
    resetLs();
    const got = setFontSize(MAX_FONT_SIZE + 100);
    assert(got === MAX_FONT_SIZE, `高于上限 124 钳位到 ${MAX_FONT_SIZE}`);
    const css = document.documentElement.style.getPropertyValue("--md-fontsize");
    assert(css === `${MAX_FONT_SIZE}px`, `CSS 钳位为 ${MAX_FONT_SIZE}px`);
}
{
    resetLs();
    const got = setFontSize(14.6);
    assert(got === 15, "小数 14.6 四舍五入到 15");
}

console.log("\napplyInitialFontSize（启动一次性恢复）：");
{
    resetLs();
    try { localStorage.setItem("litemd:fontSize", "16"); } catch { /* */ }
    const got = applyInitialFontSize();
    assert(got === 16, "从 localStorage 读取 16 返回");
    const css = document.documentElement.style.getPropertyValue("--md-fontsize");
    assert(css === "16px", "CSS 变量被同步为 16px");
}
{
    resetLs();
    const got = applyInitialFontSize();
    assert(got === DEFAULT_FONT_SIZE, "无持久化值时回退默认 14");
}

console.log("\n隐私模式降级：");
{
    resetLs();
    const origGetItem = localStorage.getItem;
    const origSetItem = localStorage.setItem;
    (localStorage as any).getItem = () => { throw new Error("denied"); };
    (localStorage as any).setItem = () => { throw new Error("denied"); };
    try {
        const got = getFontSize();
        assert(got === DEFAULT_FONT_SIZE, "getFontSize 在抛错时回退默认");
        const n = setFontSize(20);
        assert(n === 20, "setFontSize 在抛错时仍写 CSS 变量（20）");
    } finally {
        (localStorage as any).getItem = origGetItem;
        (localStorage as any).setItem = origSetItem;
    }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
