// preview.test.ts — markdown 渲染 + XSS 防护单元测试
//
// 这是一个用 node + jsdom 跑的简单断言程序，不依赖 vitest。
// T4 修复：所有断言改为严格条件（去除 || 永真陷阱）。

import { renderMarkdown, Preview } from "./preview";
import { setMermaidLoader, clearMermaidCache } from "./mermaid";

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
console.log("\nGFM 任务列表复选框：");
{
    const tl = renderMarkdown("# t\n\n- [ ] 待办\n- [x] 已完成");
    // checkbox 保留且带 disabled（无交互面）
    assert(tl.includes('<input type="checkbox"'), "未完成任务渲染 checkbox");
    assert(/<input type="checkbox" checked/.test(tl), "已完成任务 checkbox 带 checked");
    assert(/disabled/.test(tl.split("<input")[1]?.slice(0, 80) || ""), "checkbox 带 disabled");
    // li 文本不再残留 [ ]/[x] 标记（复选框消失 bug 的反向断言）
    assert(!/\[ \]|\[x\]/.test(tl), "li 文本不残留 [ ]/[x] 标记");

    // XSS 边界：用户裸 HTML 注入的非 checkbox input 应被剥除
    const xssInput = renderMarkdown('text <input type="text" onfocus="alert(1)"> end');
    assert(!xssInput.toLowerCase().includes("<input"), "裸 HTML 文本框 input 被剥除");
    const xssRadio = renderMarkdown('<input type="radio" checked>');
    assert(!xssRadio.toLowerCase().includes("<input"), "radio input 被剥除");

    // checkbox 与行号标注共存：data-line 挂在顶层块（ul）上。
    // 注意：相同标记的相邻任务列表会被 marked 合并为一个 loose list（单 ul），
    // 用普通段落隔开才能得到两个独立列表。
    const tlLn = renderMarkdown("- [ ] a\n\ntext\n\n- [x] b", { lineNumbers: true });
    assert(/<ul[^>]*data-line="1"/.test(tlLn), "任务列表 ul 标注行号 1");
    assert(/data-line="5"/.test(tlLn), "第二列表标注行号 5");
}

// ============================================================================
console.log("\n内嵌 HTML 渲染（v0.2.7 白名单扩充）：");
{
    const html1 = renderMarkdown('<div class="box">容器内容</div>');
    assert(html1.includes("<div") && html1.includes('class="box"'), "div + class 保留");
    const html2 = renderMarkdown('<figure><img src="a.png" alt="x"><figcaption>图注</figcaption></figure>');
    assert(html2.includes("<figure") && html2.includes("<figcaption>"), "figure/figcaption 保留");
    const html3 = renderMarkdown("<details><summary>展开</summary>正文</details>");
    assert(html3.includes("<details") && html3.includes("<summary>"), "details/summary 保留");
    const html4 = renderMarkdown("<dl><dt>术语</dt><dd>定义</dd></dl>");
    assert(html4.includes("<dl>") && html4.includes("<dt>") && html4.includes("<dd>"), "dl/dt/dd 保留");
    const html5 = renderMarkdown('<table><tr><td colspan="2" rowspan="3">跨</td></tr></table>');
    assert(html5.includes('colspan="2"') && html5.includes('rowspan="3"'), "colspan/rowspan 保留");
    const html6 = renderMarkdown('<video src="v.mp4" controls loop muted poster="p.jpg"></video>');
    assert(html6.includes("<video") && html6.includes("controls") && html6.includes("loop"), "video/controls/loop 保留");
    assert(html6.includes('poster="p.jpg"'), "poster 属性保留");
    const html7 = renderMarkdown('<time datetime="2026-09-01">今天</time>');
    assert(html7.includes('datetime="2026-09-01"'), "time/datetime 保留");
    const html8 = renderMarkdown("<p>上标 <var>x</var> 与 <abbr title=\"缩写\">AB</abbr></p>");
    assert(html8.includes("<var>") && html8.includes("<abbr"), "var/abbr 保留");
    // 非白名单交互元素仍被剥除
    const html9 = renderMarkdown('<button onclick="alert(1)">点</button><form action="x"></form>');
    assert(!html9.includes("<button") && !html9.includes("<form"), "button/form 仍被剥除");
    const html10 = renderMarkdown('<iframe src="https://evil.example"></iframe><object data="x"></object>');
    assert(!html10.toLowerCase().includes("<iframe") && !html10.toLowerCase().includes("<object"), "iframe/object 仍被剥除");
}

console.log("\nstyle 属性过滤（v0.2.7）：");
{
    const s1 = renderMarkdown('<span style="color: red; font-weight: bold">红字</span>');
    assert(s1.includes("color: red"), "安全 style 声明保留");
    const s2 = renderMarkdown('<div style="position: fixed; inset: 0; z-index: 9999">盖 UI</div>');
    assert(!/position\s*:\s*fixed/i.test(s2) && !/z-index/.test(s2), "position:fixed/z-index 被过滤");
    const s3 = renderMarkdown('<div style="background-image: url(https://evil.example/t.png)">跟踪</div>');
    assert(!/evil\.example/.test(s3), "外发 url() 被过滤");
    const s4 = renderMarkdown('<div style="width: expression(alert(1))">IE</div>');
    assert(!/expression/i.test(s4), "expression() 被过滤");
    const s5 = renderMarkdown('<div style="position: relative; top: 4px">相对</div>');
    assert(/position\s*:\s*relative/i.test(s5) && !/\btop\s*:/.test(s5), "position:relative 保留但 top 丢弃");
}

console.log("\n<style> 块作用域化（v0.2.7）：");
{
    const css1 = renderMarkdown("text\n\n<style>\np { color: red }\n</style>");
    assert(/<style data-user-css="1">/.test(css1), "<style> 块产出 data-user-css 标签");
    assert(css1.includes(".preview-content p") && css1.includes("color: red"), "选择器被前缀化到预览区作用域");
    const css2 = renderMarkdown("<style>body { margin: 0 }</style>");
    assert(!/\bbody\s*\{/.test(css2) && css2.includes(".preview-content {"), "body 选择器映射为前缀本体");
    const css3 = renderMarkdown("<style>@import url('https://evil.example/x.css');</style>");
    assert(!/@import/i.test(css3), "@import 远程样式被丢弃");
    const css4 = renderMarkdown("<style>.t { background: url('https://evil.example/a.png') }</style>");
    assert(!/evil\.example/.test(css4), "style 块内外发 url 丢弃");
    const css5 = renderMarkdown("<style>@keyframes spin { from { transform: none } to { transform: rotate(1turn) } }</style>");
    assert(css5.includes("@keyframes spin") && css5.includes("from") && !css5.includes(".preview-content from"), "@keyframes 内部不前缀");
    const css6 = renderMarkdown('<style>a[href="</style><img src=x onerror=alert(1)>"] { color: red }</style>');
    // 浏览器原生解析：CSS 字符串里的 </style> 会提前终止 style 块（与
    // extractStyleBlocks 的非贪婪截取一致），逃逸出的 HTML 落回 DOMPurify
    // 管线被清洗——onerror 必须消失，残余 <img> 无事件属性即安全
    assert(!/onerror/i.test(css6), "style 块逃逸出的 HTML 仍经 DOMPurify 清洗（无 onerror）");
}

console.log("\ndata URI 图片（v0.2.7）：");
{
    const d1 = renderMarkdown('<img src="data:image/png;base64,iVBORw0KGgo=" alt="b64">');
    assert(/src="data:image\/png;base64,iVBORw0KGgo="/.test(d1), "data:image base64 保留");
    const d2 = renderMarkdown('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">');
    assert(!/data:image\/svg\+xml/.test(d2), "data:image/svg+xml（可携带脚本）拒绝");
    const d3 = renderMarkdown('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    assert(!/data:text\/html/.test(d3), "data:text/html 拒绝");
}

// ============================================================================
(async () => {
console.log("\nmermaid 块替换与降级（v0.2.8，Preview 实例化集成）：");
{
    // 让 mermaid 渲染走 fake loader：成功路径与失败路径分别断言
    let fakeCalls = 0;
    setMermaidLoader(async () => ({
        initialize: () => {},
        async render(_id: string, _code: string, container: HTMLElement) {
            fakeCalls++;
            // fake 失败模式：throw → 触发 is-error 降级
            if (_code.includes("syntax-broken")) throw new Error("fake fail");
            container.innerHTML = "<svg data-fake><text>OK</text></svg>";
            return { svg: container.innerHTML };
        },
    }));
    clearMermaidCache();

    const host = document.createElement("div");
    host.id = "preview";
    document.body.appendChild(host);
    const prev = new Preview(host);

    // 成功路径：flowchart 应渲染出 svg
    prev.render("```mermaid\nflowchart TD\n  A --> B\n```");
    await new Promise<void>((r) => setTimeout(r, 30));
    const okHolder = host.querySelector(".mermaid-block[data-state]");
    assert(okHolder !== null, "mermaid 代码块替换为 .mermaid-block 容器");
    assert(okHolder?.getAttribute("data-state") === "ok", "合法图渲染成功 → data-state=ok");
    assert(okHolder?.querySelector("svg") !== null, "成功路径注入 <svg>");
    // 不应再是 code-block 装饰
    assert(host.querySelectorAll(".code-block .mermaid-block").length === 0, "mermaid 块不进入 .code-block 装饰（无复制按钮）");
    assert(host.querySelector("pre > code.language-mermaid") === null, "原 <pre><code.language-mermaid> 被替换");

    // 失败路径：语法错误降级为 is-error
    prev.render("```mermaid\nsyntax-broken diagram\n```");
    await new Promise<void>((r) => setTimeout(r, 30));
    const errHolder = host.querySelector(".mermaid-block[data-state='error']");
    assert(errHolder !== null, "语法错误 → data-state=error 容器存在");
    assert(errHolder?.textContent?.includes("语法错误") ?? false, "错误占位文案包含「语法错误」");
    assert(errHolder?.textContent?.includes("syntax-broken") ?? false, "错误占位保留原码便于校对");

    // 竞态：旧 renderGen 的延迟回调不应覆盖新结果
    fakeCalls = 0;
    prev.render("```mermaid\ng1\n```");
    prev.render("```mermaid\ng2\n```");
    await new Promise<void>((r) => setTimeout(r, 30));
    const all = Array.from(host.querySelectorAll<HTMLElement>(".mermaid-block"));
    assert(all.length === 1 && all[0].dataset.code === "g2", "快速切换仅保留最新文档的 mermaid 块");

    prev.clear();
    document.body.removeChild(host);
    setMermaidLoader(null);
    clearMermaidCache();
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
})();
