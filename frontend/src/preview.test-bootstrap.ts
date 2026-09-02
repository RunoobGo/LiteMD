// preview.test-bootstrap.ts — 在 node 环境下跑前端测试套件
// 提供 DOMPurify 与 DOMParser 需要的 window/document（通过 jsdom）

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
// @ts-ignore - jsdom 不在 TypeScript 标准库
(globalThis as any).window = dom.window as any;
(globalThis as any).document = dom.window.document;
// DOMPurify 需要 navigator
Object.defineProperty((globalThis as any).window.navigator, "userAgent", { value: "node" });
// F10 修复后 preview.ts 使用 DOMParser 加固 link，需暴露到 globalThis
(globalThis as any).DOMParser = dom.window.DOMParser;
// v0.2.8 mermaid.ts ensureInitialized 调用 getComputedStyle（不挂会 TypeError）
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// titlebar.test.ts 派发 dblclick / resize 需要
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;

// 套件注册表（#4 修复：表驱动，新增套件在此登记即可，all 自动包含）
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
};

// 选择要跑哪套测试；all = 全量（含 titlebar / tabs，与 README/TECHNICAL 承诺一致）
const target = process.env.LITEMD_TEST || "preview";
if (target === "both" || target === "all") {
    for (const mod of Object.values(suites)) import(mod);
} else if (suites[target]) {
    import(suites[target]);
} else {
    import("./preview.test");
}
