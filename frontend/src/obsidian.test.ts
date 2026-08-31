// obsidian.test.ts — Sprint 3 单元测试（jsdom 跑）

import {
    findWikiLinks,
    preprocessWikiLinks,
    findCallouts,
    preprocessCallouts,
    parseFrontmatter,
    preprocessAll,
} from "./obsidian";

let pass = 0; let fail = 0;
function assert(cond: boolean, msg: string) {
    if (cond) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg); }
}
function assertEq(a: unknown, b: unknown, msg: string) {
    if (a === b) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg + " (want=" + JSON.stringify(b) + " got=" + JSON.stringify(a) + ")"); }
}

// ============================================================================
console.log("Wiki Links:");
assert(findWikiLinks("see [[foo]]").length === 1, "基本 [[foo]] 命中");
const links = findWikiLinks("see [[Note A]] and [[Note B|alias]]");
assertEq(links.length, 2, "两个链接");
assertEq(links[0].target, "Note A", "链接1 target");
assertEq(links[1].alias, "alias", "链接2 alias");
assertEq(findWikiLinks("normal text without links").length, 0, "无链接");

const wikiHtml = preprocessWikiLinks("see [[Note A]] [[Note B|alt]]");
assert(wikiHtml.includes('class="wiki-link"'), "渲染 wiki-link class");
assert(wikiHtml.includes('data-wikilink="Note A"'), "data-wikilink 第一条");
assert(wikiHtml.includes(">alt<"), "显示别名");
assert(wikiHtml.includes('href="#/wiki/'), "href 锚点");

// XSS 安全：[[Note<script>]] 应该被去除 <script>
const safe = preprocessWikiLinks("see [[Note<script>alert(1)</script>]]");
assert(!safe.includes("<script>"), "wiki 链接 XSS 过滤");

// ============================================================================
console.log("\nCallouts:");
const callouts = findCallouts(`
> [!note] Optional title
> body line 1
> body line 2
`);
assertEq(callouts.length, 1, "找到 1 个 callout");
assertEq(callouts[0].type, "note", "类型 = note");
assert(callouts[0].body.includes("body line 1"), "body 包含内容");

const c2 = findCallouts("> [!danger]\n> be careful");
assertEq(c2.length, 1, "danger 类型");
assertEq(c2[0].type, "danger", "danger 类型");

const c3 = findCallouts("> not a callout");
assertEq(c3.length, 0, "非 callout 块不识别");

const processed = preprocessCallouts(`> [!warning] Watch out
> This is risky`);
assert(processed.includes('class="callout callout-warning"'), "preprocess 输出 callout-warning class");
assert(processed.includes("Watch out"), "包含 title 文本");
assert(processed.includes("callout-body"), "包含 body 容器");

// N1 修复验证：callout 正文需渲染 Markdown（Obsidian 兼容保真）
const calloutBody = preprocessCallouts(`> [!note] 提示
> 这是 **加粗** 和 \`代码\``);
assert(calloutBody.includes("<strong>"), "N1: callout 正文 **加粗** 渲染为 <strong>");
assert(calloutBody.includes("<code>"), "N1: callout 正文 `代码` 渲染为 <code>");
assert(calloutBody.includes("callout-note"), "N1: callout 类型 class 保留");

// ============================================================================
console.log("\nFrontmatter:");
const fm1 = parseFrontmatter(`---
title: My Note
tags: [work, urgent]
date: 2024-01-01
---

# Body here
`);
assert(fm1.frontmatter !== null, "frontmatter 解析");
assertEq(fm1.frontmatter?.data.title, "My Note", "title 字段");
assertEq(fm1.frontmatter?.data.date, "2024-01-01", "date 字段");
assertEq(fm1.body, "# Body here\n", "body 不含 frontmatter");

const fm2 = parseFrontmatter(`# No frontmatter here`);
assertEq(fm2.frontmatter, null, "无 frontmatter");
assertEq(fm2.body, "# No frontmatter here", "body 全保留");

const fm3 = parseFrontmatter(`---
quoted: "Hello World"
---`);
assertEq(fm3.frontmatter?.data.quoted, "Hello World", "引号值去除");

// ============================================================================
console.log("\nPipeline preprocessAll:");
const full = preprocessAll(`---
title: Test
---

# Heading

> [!tip] Pro tip
> Do this

see [[Note X]] and [[Note Y|Display]]

End.`);
assert(full.includes("callout-tip"), "callout 被保留");
assert(full.includes("wiki-link"), "双链被识别");
assert(!full.includes("[[Note X]]"), "原始 [[]] 被替换");
// T6 修复：startsWith || includes 是包含关系（startsWith 真 => includes 真），冗余弱化预期。直接严格判断子串
assert(full.includes("# Heading"), "body 完整：包含标题行");

// ============================================================================
console.log("Test: parseFrontmatter（边界 + CRLF）");
{
    // T12 修复：新增 Windows CRLF frontmatter 解析测试（F17 修复后验证）
    const fmcrlf = "---\r\nfoo: bar\r\nbaz: qux\r\n---\r\nbody";
    const resultCRLF = parseFrontmatter(fmcrlf);
    const fmCRLF = resultCRLF.frontmatter?.data as any;
    assert(fmCRLF && fmCRLF.foo === "bar" && fmCRLF.baz === "qux",
           "CRLF frontmatter 解析正确（F17 修复验证） — data.foo=" + (fmCRLF?.foo ?? "undef"));

    // 空 key value（key: 无内容）
    const resultEmpty = parseFrontmatter("---\ntitle:\n---\ntext");
    const fmEmpty = resultEmpty.frontmatter?.data as any;
    // 空 value 被 trim 后是空串，对象应存在且含 title 键
    const titleOK = fmEmpty && "title" in fmEmpty;
    assert(titleOK, "空 value frontmatter 不崩溃");

    // value 含冒号（如 URL 带端口）
    const resultColon = parseFrontmatter("---\nurl: https://example.com:8080/path\n---\ntext");
    const fmColon = resultColon.frontmatter?.data as any;
    assert(fmColon && fmColon.url === "https://example.com:8080/path",
           "value 内带冒号（URL 含端口）正确解析： got=" + (fmColon?.url ?? "undef"));
}

// ============================================================================
console.log("Test: ReDoS 防护（WIKI_RE 不得退化回 O(n²)）");
{
    // 回归守卫：旧版 WIKI_RE 用惰性量词 `[^\]\n|]+?` 且不排除 `[`，
    // 面对 `[[[[[[…` 这类输入时每个起始位置都要惰性扩展到行尾 → 整体 O(n²)。
    // 实测 64000 个 `[` 旧版耗时 3058ms，新版 0.12ms。此测试锁定该行为。
    const adversarial = "[".repeat(32000);
    const t0 = Date.now();
    const found = findWikiLinks(adversarial);
    const elapsed = Date.now() - t0;
    assert(elapsed < 200, `32000 个 "[" 扫描在 200ms 内完成（实测 ${elapsed}ms）`);
    assert(found.length === 0, "纯 [ 洪流不产生任何 wiki 链接匹配");

    const nested = "[[".repeat(16000);
    const t1 = Date.now();
    const foundNested = findWikiLinks(nested);
    const elapsed2 = Date.now() - t1;
    assert(elapsed2 < 200, `16000 个 "[[" 扫描在 200ms 内完成（实测 ${elapsed2}ms）`);
    assert(foundNested.length === 0, "[[ 洪流不产生任何 wiki 链接匹配");

    // 未闭合链接：真实场景（用户边打字边保存）
    const unclosed = "[[未写完的链接名" + "a".repeat(20000);
    const t2 = Date.now();
    findWikiLinks(unclosed);
    assert(Date.now() - t2 < 200, "20000 字符未闭合 [[ 扫描在 200ms 内完成");

    // 语义收紧：链接目标/别名内不允许 `[`（与 Obsidian 行为一致）
    assert(findWikiLinks("[[a[b]]").length === 0, "目标含 [ 的写法不匹配（语义收紧）");
    const inner = findWikiLinks("[[外层[[内层]]");
    assert(inner.length === 1 && inner[0].target === "内层",
           "嵌套 [[ 取最内层链接（避免贪婪吞并）");

    // 长度上限：超长目标不匹配，而非卡死
    assert(findWikiLinks("[[" + "a".repeat(300) + "]]").length === 0,
           "超过 256 字符的链接目标不匹配（有界量词生效）");
    assert(findWikiLinks("[[" + "a".repeat(200) + "]]").length === 1,
           "200 字符的链接目标正常匹配");
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
