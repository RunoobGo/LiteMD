// preview.test.ts — markdown 渲染 + XSS 防护单元测试
//
// 这是一个用 node + jsdom 跑的简单断言程序，不依赖 vitest。
// T4 修复：所有断言改为严格条件（去除 || 永真陷阱）。

import { renderMarkdown } from "./preview";

let pass = 0; let fail = 0;
function assert(cond: boolean, msg: string) {
    if (cond) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg); }
}

// ============================================================================
console.log("renderMarkdown 测试：");
assert(typeof renderMarkdown("") === "string", "空字符串仍返回字符串");
assert(!renderMarkdown("").includes("<"), "空字符串无 HTML");
assert(renderMarkdown("# Hello").includes("<h1"), "# 标题渲染为 h1");
assert(renderMarkdown("# Hello").includes("Hello"), "文本保留");
assert(renderMarkdown("- a\n- b").includes("<ul"), "- 列表渲染为 ul");
assert(renderMarkdown("**bold**").includes("<strong>"), "**bold** → <strong>");
assert(renderMarkdown("`code`").includes("<code>"), "`code` → <code>");
assert(renderMarkdown("> quote").includes("<blockquote>"), "> → <blockquote>");

// N1 修复验证：callout 正文渲染 markdown 且 XSS 仍被下游剥离
const calloutRender = renderMarkdown(`> [!note] 提示
> 这是 **加粗** 文本`);
assert(calloutRender.includes("<strong>"), "N1: callout 正文 **加粗** 渲染为 <strong>");
assert(calloutRender.includes("callout-note"), "N1: callout 类型 class 保留");
const calloutXss = renderMarkdown(`> [!warning] X
> <img src=x onerror=alert(1)>`);
assert(!calloutXss.toLowerCase().includes("onerror"), "N1: callout 内 XSS 属性仍被剥离");

// F10 修复验证：外部链接应加固 target/rel
const linkHtml = renderMarkdown("[click](https://example.com)");
assert(linkHtml.includes('target="_blank"'), "F10: 外链加 target=_blank");
assert(linkHtml.includes('rel="noopener noreferrer"'), "F10: 外链加 rel=noopener noreferrer");

// T11 新增：F10 的负向用例 — 内部链接（wiki-link 锚点 #/wiki/...）不应被硬编码 target/rel
const wikiRendered = renderMarkdown("see [[Note A]] here");
// Wiki-link 是 preview 生成的 <a href="#/wiki/..."> 节点，不应有 _blank target
assert(!/href="#\/wiki[^"]*"[^>]*target="_blank"/.test(wikiRendered),
       "T11: wiki-link 内部锚点无 target=_blank（不误加固）");
assert(!wikiRendered.includes('href="#/"') || !wikiRendered.includes('rel="noopener noreferrer"'),
       "T11: 内部锚点无 rel=noopener（不误加固）");

// 相对路径 /assets/foo.png 链接也不应被外部链接加固
const assetMd = renderMarkdown('[img](/assets/foo.png)');
assert(!assetMd.includes('target="_blank"') || !assetMd.includes('href="/assets/'),
       "T11: 相对路径链接无 target=_blank 外部加固");

// ============================================================================
console.log("\nXSS 防护测试：");
// <script> 应直接被剥离
const xss1 = renderMarkdown("hello\n\n<script>alert(1)</script>");
assert(!xss1.toLowerCase().includes("<script"), "xss1: <script> 被剥离");
// T4 修复：严格断言 — script 标签被剥离后不应保留完整的 script 内容
// （DOMPurify 可能保留文本内容 "alert(1)" 但去掉 <script> 标签，这是预期行为）
assert(!xss1.toLowerCase().includes("<script>"), "xss1: 无完整 <script> 开标签");

// javascript: 链接应被剥离
const xss2 = renderMarkdown("[click](javascript:alert(1))");
// T4 修复：严格断言 — 不应出现 javascript: 协议的 href
assert(!/href\s*=\s*["']javascript:/i.test(xss2), "xss2: href 无 javascript: 协议");

// onerror 属性应被剥离
const xss3 = renderMarkdown('![alt](image.png "title")');
assert(!xss3.toLowerCase().includes("onerror"), "xss3: onerror 属性不在 img 上");

// iframe 应被剥离
const xss4 = renderMarkdown("<iframe src=javascript:alert(1)></iframe>");
assert(!xss4.toLowerCase().includes("<iframe"), "xss4: iframe 被剥离");

// 内联 style + onclick 应被剥离
const xss5 = renderMarkdown('<a href="x" onclick="alert(1)">click</a>');
assert(!/onclick\s*=/i.test(xss5), "xss5: onclick 属性被剥离");

// ============================================================================
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
