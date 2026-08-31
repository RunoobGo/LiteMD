// tabs.test.ts — TabManager 状态机单元测试（纯逻辑，无 DOM 依赖）
//
// 重点覆盖 #2 修复的回归守卫：保存 IO 窗口期的新输入不被 baseline 回写覆盖。

import { TabManager } from "./tabs";

let pass = 0; let fail = 0;
function assertEq(a: unknown, b: unknown, msg: string) {
    if (a === b) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg + " (want=" + JSON.stringify(b) + " got=" + JSON.stringify(a) + ")"); }
}

function fresh(): { tm: TabManager; events: number } {
    let events = 0;
    return { tm: new TabManager(() => events++), events };
}

// ============================================================================
console.log("生命周期：");
{
    const { tm } = fresh();
    const t = tm.newTab();
    assertEq(t.title, "Untitled-1.md", "新建标签默认标题");
    assertEq(t.dirty, false, "新建即干净");
    assertEq(tm.activeId, t.id, "新建自动激活");

    const t2 = tm.openTab("/docs/笔记.md", "# 内容");
    assertEq(t2.title, "笔记.md", "打开标签取文件名");
    assertEq(tm.order.length, 2, "两个标签按序");

    // 路径去重：重复打开已打开文件应激活而非新建
    const again = tm.openTab("/docs/笔记.md", "# 内容");
    assertEq(again.id, t2.id, "重复打开激活已有标签");
    assertEq(tm.order.length, 2, "不产生重复标签");
}

// ============================================================================
console.log("dirty 跟踪：");
{
    const { tm } = fresh();
    const t = tm.openTab("/a.md", "hello");
    tm.syncLiveContent(t.id, "hello world");
    assertEq(t.dirty, true, "编辑后变脏");
    tm.syncLiveContent(t.id, "hello");
    assertEq(t.dirty, false, "改回原文恢复干净");
}

// ============================================================================
console.log("#2 回归：保存 IO 窗口期的新输入不被覆盖：");
{
    const { tm } = fresh();
    const t = tm.openTab("/a.md", "hello");
    // 模拟保存流程：handleSave 先取编辑器快照
    const snapshot = "hello"; // 用户此刻的输入
    // await saveFile(...) 的 IO 窗口期内用户继续输入：
    tm.syncLiveContent(t.id, "hello world!"); // 新输入已同步进 liveContent
    // 保存完成，推进 baseline（携带的是旧快照）：
    tm.updateContentBaseline(t.id, snapshot, "/a.md", 123);
    assertEq(t.liveContent, "hello world!", "liveContent 保留 IO 窗口期的新输入（不被快照覆盖）");
    assertEq(t.baseline, "hello", "baseline 推进为保存的快照");
    assertEq(t.dirty, true, "保存期间有新输入 → 保持脏（提示用户再次保存）");
}
{
    const { tm } = fresh();
    const t = tm.openTab("/a.md", "hello");
    tm.syncLiveContent(t.id, "hello v2"); // 用户输入
    const snapshot = "hello v2";
    tm.updateContentBaseline(t.id, snapshot, "/a.md", 123); // 期间无新输入
    assertEq(t.dirty, false, "保存期间无新输入 → 干净（原语义保留）");
    assertEq(t.liveContent, "hello v2", "liveContent 与 baseline 一致");
}

// ============================================================================
console.log("关闭与激活转移：");
{
    const { tm } = fresh();
    const a = tm.openTab("/a.md", "a");
    const b = tm.openTab("/b.md", "b");
    tm.activate(a.id);
    tm.closeTab(a.id, true);
    assertEq(tm.activeId, b.id, "关闭后激活相邻标签");
    const c = tm.openTab("/c.md", "c");
    tm.closeTab(c.id, true);
    assertEq(tm.activeId, b.id, "关闭非活动标签不影响激活");
    const r = tm.closeTab(b.id, true);
    assertEq(r.closed, true, "最后一个标签可关闭");
    assertEq(tm.activeId, null, "全关闭后无活动标签");
}
{
    const { tm } = fresh();
    const t = tm.openTab("/a.md", "a");
    const r1 = tm.closeTab(t.id); // dirty=false，无需 force
    assertEq(r1.closed, true, "干净标签可直接关闭");
    const t2 = tm.openTab("/b.md", "b");
    tm.syncLiveContent(t2.id, "b2"); // 变脏
    const r2 = tm.closeTab(t2.id); // 不带 force
    assertEq(r2.closed, false, "脏标签无 force 拒绝关闭");
    assertEq(r2.reason, "dirty", "拒绝原因 = dirty");
}

// ============================================================================
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
