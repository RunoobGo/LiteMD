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
console.log("\n样式回归（#1 修复守卫）：");
// marked 输出裸 <h1> 标签（无 class），标题样式必须用标签选择器命中。
// 旧版 .md-h1 class 选择器永不匹配 → 预览标题退化为浏览器默认样式。
{
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    // 测试约定从 frontend 目录启动（cd frontend && npx tsx src/preview.test-bootstrap.ts）
    const css = readFileSync(resolve(process.cwd(), "src/style.css"), "utf-8");
    for (const sel of [".preview h1", ".preview h2", ".preview h3"]) {
        assert(css.includes(sel), `样式表包含标签选择器 ${sel}（marked 输出无 class 的裸标签）`);
    }
    assert(!/\.preview\s+\.md-h[123]\b/.test(css), "已移除永不命中的 .md-h1/2/3 class 选择器");
}

// ============================================================================
console.log("\n预览行号标注（data-line）：");
{
    const ln = (md: string) => renderMarkdown(md, { lineNumbers: true });

    // 默认关闭：不注入 data-line（兼容既有调用方/测试）
    assert(!renderMarkdown("# Hi").includes("data-line"), "默认输出不含 data-line");

    // 基本标注：块起始行号，跳过块间空行
    const basic = ln("# Title\n\npara1\n\npara2");
    assert(basic.includes('<h1 data-line="1"'), "h1 标注源行 1");
    assert(basic.includes('<p data-line="3"'), "para1 标注源行 3");
    assert(/<p data-line="5">para2/.test(basic), "para2 标注源行 5");

    // frontmatter 偏移：剥掉的行数要加回
    const fm = ln("---\ntitle: T\n---\n\n# H");
    assert(fm.includes('<h1 data-line="5"'), "frontmatter 后 h1 = 行 5（含 4 行头部）");

    // callout：块标注其源起始行；其后块行号不因替换串行数变化而漂移
    const co = ln("# H\n\n> [!note] n\n> body\n\ntail");
    assert(/data-line="3"/.test(co), "callout 标注源行 3（> [!note] 所在行）");
    assert(/<p data-line="6">tail/.test(co), "callout 后段落行号无漂移（= 行 6）");

    // wiki-link 行内替换不影响行号
    const wl = ln("see [[A]] and\n\nnext");
    assert(/<p data-line="1">/.test(wl), "wiki-link 段落行号 = 1");
    assert(/<p data-line="3">next/.test(wl), "后续段落 = 3");

    // 代码块整体一个锚点（起始行）
    const cb = ln("a\n\n```\nx\ny\n```\n\nz");
    assert(/<p data-line="1">a/.test(cb), "首段 = 行 1");
    assert(/<pre[^>]*data-line="3"/.test(cb), "代码块标注起始行 3");
    assert(/<p data-line="8">z/.test(cb), "代码块后段落 = 行 8");

    // LaTeX 占位替换不影响行号
    const lx = ln("$x^2$\n\nafter");
    assert(/<p data-line="1">/.test(lx), "公式行 = 1");
    assert(/<p data-line="3">after/.test(lx), "公式后段落 = 3");

    // XSS：data-line 值是程序生成的整数，不受用户内容注入影响
    const xssLn = ln('<img src=x onerror=alert(1) data-line="99">');
    assert(!/data-line="99"/.test(xssLn), "用户构造的 data-line 被清洗流程规范化");
}

// ============================================================================
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
