// preview.test-bootstrap.ts — 在 node 环境下跑 preview.test.ts
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

// 选择要跑哪套测试
const target = process.env.LITEMD_TEST || "preview";
if (target === "obsidian") {
    import("./obsidian.test");
} else if (target === "both" || target === "all") {
    import("./preview.test");
    import("./obsidian.test");
} else {
    import("./preview.test");
}
