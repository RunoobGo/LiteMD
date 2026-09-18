// preview.test-bootstrap.ts — 在 node 环境下跑前端测试套件
//
// 运行模型（P0-7 修复）：
//   - 父模式（默认，LITEMD_TEST 未设/LITEMD_TEST=all）：为每个套件 spawn 一个
//     独立子进程串行执行，退出码聚合后统一上报。旧版在同一 jsdom 里并发
//     import 全部 10 个套件：DOM body 共享 + mermaid loader 单例争抢，
//     LITEMD_TEST=all 实测崩溃，且任一套件 process.exit(1) 会杀掉整个进程，
//     其余套件根本没有机会跑 —— 这就是「写了测试但没有一条真正跑过」的原因。
//   - 子模式（LITEMD_SUITE=<name>）：搭好 jsdom 全局后加载单个套件。
//     套件失败自带 process.exit(1)，子进程退出码即套件结果。
//
// 用法：
//   npm test                     # 全量 10 套件（逐个隔离跑）
//   LITEMD_TEST=mermaid npm test # 只跑指定套件
//   LITEMD_TEST=all npm test     # 同默认

import { JSDOM } from "jsdom";
import { spawnSync } from "node:child_process";
import path from "node:path";

// 套件注册表（表驱动，新增套件在此登记即可，all 自动包含）
const suites: Record<string, string> = {
    preview: "./preview.test",
    obsidian: "./obsidian.test",
    latex: "./latex.test",
    titlebar: "./titlebar.test",
    tabs: "./tabs.test",
    "md-escape": "./md-escape.test",
    toc: "./toc.test",
    "link-handler": "./link-handler.test",
    "user-css": "./user-css.test",
    "mermaid": "./mermaid.test",
    "font-size": "./font-size.test",
    errcode: "./errcode.test",
    "file-ops": "./file-ops.test",
    sidebar: "./sidebar.test",
    splitpane: "./splitpane.test",
    "unsaved-guard": "./unsaved-guard.test",
    env: "./env.test",
};

const suiteName = process.env.LITEMD_SUITE;

if (suiteName) {
    // ------------------------------------------------------------------
    // 子模式：jsdom 全局 + 单套件
    // ------------------------------------------------------------------
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
    // @ts-ignore - jsdom 不在 TypeScript 标准库
    (globalThis as any).window = dom.window as any;
    (globalThis as any).document = dom.window.document;
    // DOMPurify 需要 navigator
    Object.defineProperty((globalThis as any).window.navigator, "userAgent", { value: "node" });
    // 全局 navigator 自 Node 21 才内置。tabs.ts / tabs.test.ts 会直接引用裸 navigator，
    // 在 Node 20 上会抛 ReferenceError（CI 曾以此失败）。缺失时回落到 jsdom 的实现。
    if (typeof (globalThis as any).navigator === "undefined") {
        (globalThis as any).navigator = dom.window.navigator;
    }
    // F10 修复后 preview.ts 使用 DOMParser 加固 link，需暴露到 globalThis
    (globalThis as any).DOMParser = dom.window.DOMParser;
    // mermaid.ts ensureInitialized 调用 getComputedStyle（不挂会 TypeError）
    (globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    // titlebar.test.ts 派发 dblclick / resize 需要
    (globalThis as any).MouseEvent = dom.window.MouseEvent;
    (globalThis as any).Event = dom.window.Event;
    (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
    // font-size.test.ts 模拟 localStorage 抛错
    (globalThis as any).localStorage = dom.window.localStorage;

    const mod = suites[suiteName] ?? "./preview.test";
    void import(mod); // 套件失败自带 process.exit(1)，子进程退出码即结果
} else {
    // ------------------------------------------------------------------
    // 父模式：逐套件派发隔离子进程，聚合退出码
    // ------------------------------------------------------------------
    const target = process.env.LITEMD_TEST || "all";
    const names = target === "all" || target === "both"
        ? Object.keys(suites)
        : (suites[target] ? [target] : Object.keys(suites));
    if (!suites[target] && target !== "all" && target !== "both") {
        console.error(`未知套件：${target}（可选：${Object.keys(suites).join(", ")}）`);
    }

    // 复用父进程的 loader（tsx 通过 execArgv 注入），保证子进程能跑 TS
    const bootstrap = path.resolve(process.argv[1] || "src/preview.test-bootstrap.ts");
    const failed: string[] = [];
    for (const name of names) {
        console.log(`\n===== 套件 ${name} =====`);
        const r = spawnSync(process.execPath, [...process.execArgv, bootstrap], {
            env: { ...process.env, LITEMD_SUITE: name },
            stdio: "inherit",
        });
        if (r.status !== 0) failed.push(name);
    }
    console.log(`\n===== 汇总：${names.length - failed.length}/${names.length} 套件通过` +
        (failed.length ? `，失败：${failed.join(", ")}` : "") + " =====");
    process.exit(failed.length ? 1 : 0);
}
