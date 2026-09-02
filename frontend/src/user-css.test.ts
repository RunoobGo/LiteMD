// user-css.test.ts — 内嵌 CSS 安全层单元测试（v0.2.7）
//
// 覆盖三类能力：
//   1. scopeUserCss：选择器作用域前缀化（含 at-rule 分支）
//   2. filterDeclarations / filterInlineStyle：声明黑名单与 url() 白名单
//   3. extractStyleBlocks / buildUserStyleTag：提取与 HTML 逃逸防护

import {
    scopeUserCss,
    filterDeclarations,
    filterInlineStyle,
    extractStyleBlocks,
    buildUserStyleTag,
    SCOPE_PREFIX,
} from "./user-css";

let pass = 0; let fail = 0;
function assert(cond: boolean, msg: string) {
    if (cond) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg); }
}
const P = SCOPE_PREFIX;

// ============================================================================
console.log("scopeUserCss — 普通规则前缀化：");
{
    const out = scopeUserCss("p { color: red; }");
    assert(out.includes(`${P} p`), "普通选择器加前缀");
    assert(out.includes("color: red"), "声明原样保留");
}
{
    const out = scopeUserCss("h1, h2.title { margin: 0 }");
    assert(out.includes(`${P} h1`) && out.includes(`${P} h2.title`), "逗号多选择器逐个加前缀");
}
{
    const out = scopeUserCss("* { box-sizing: border-box }");
    assert(out.includes(`${P} *`), "通配符选择器加前缀");
}
{
    const out = scopeUserCss(".a:not(.b, .c) > .d { color: blue }");
    assert(out.includes(`${P} .a:not(.b, .c) > .d`), ":not() 内逗号不破坏分割");
}
{
    const out = scopeUserCss("a[href^='x,'] { color: red }");
    assert(out.includes(`${P} a[href^='x,']`), "属性选择器字符串内逗号不分割");
}

console.log("scopeUserCss — html/body/:root 映射：");
{
    const out = scopeUserCss("body { font-family: sans-serif }");
    assert(new RegExp(`${P.replace(".", "\\.")}\\s*\\{`).test(out), "body 选择器映射为前缀本体");
    assert(!/\bbody\b/.test(out), "body 字样不再出现");
}
{
    const out = scopeUserCss("html, body, :root { --x: 1 }");
    const hits = out.split(P).length - 1;
    assert(hits >= 3, "html/body/:root 列表全部映射（得到 3 处前缀）");
}
{
    const out = scopeUserCss("body > p { color: red }");
    assert(out.includes(`${P} p`), "body > p 映射为前缀 + p");
}
{
    const out = scopeUserCss(":root { --main: #0ff }");
    assert(out.includes("--main: #0ff"), "自定义属性定义保留（:root 映射后）");
}

console.log("scopeUserCss — at-rule 分支：");
{
    const css = "@media (min-width: 100px) { .box { width: 50% } }";
    const out = scopeUserCss(css);
    assert(out.includes("@media (min-width: 100px)"), "@media 条件保留");
    assert(out.includes(`${P} .box`), "@media 内规则仍加前缀");
}
{
    const css = "@supports (display: grid) { .g { display: grid } }";
    const out = scopeUserCss(css);
    assert(out.includes("@supports (display: grid)") && out.includes(`${P} .g`), "@supports 内递归前缀");
}
{
    const css = "@media (prefers-reduced-motion: reduce) { @media (min-width: 1px) { .n { top: 0 } } }";
    const out = scopeUserCss(css);
    assert((out.match(/@media/g) || []).length === 2, "@media 嵌套递归保留两层");
    assert(!/\btop\b/.test(out), "嵌套内 top 声明仍被黑名单拦截");
}
{
    const css = "@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }";
    const out = scopeUserCss(css);
    assert(out.includes("@keyframes spin"), "@keyframes 名保留");
    assert(out.includes("from") && out.includes("to"), "keyframe 选择器不被加前缀");
    assert(!out.includes(P), "@keyframes 内部无前缀污染");
}
{
    const css = "@font-face { font-family: X; src: url(data:font/woff2;base64,AA) format('woff2') }";
    const out = scopeUserCss(css);
    assert(out.includes("@font-face"), "@font-face 结构保留");
    assert(out.includes("data:font/woff2"), "data: 字体 url 保留");
}
{
    const css = "@font-face { src: url(https://evil.example/f.woff2) }";
    assert(!scopeUserCss(css).includes("evil.example"), "@font-face 远程 url 被丢弃");
}
{
    const css = "@import url('https://evil.example/x.css'); p { color: red }";
    const out = scopeUserCss(css);
    assert(!/@import/i.test(out), "@import 被丢弃");
    assert(out.includes(`${P} p`), "@import 之后的规则不受影响");
}
{
    const css = "@charset 'utf-8'; @namespace svg url(http://www.w3.org/2000/svg); .q { color: red }";
    const out = scopeUserCss(css);
    assert(!/@charset/i.test(out) && !/@namespace/i.test(out), "@charset/@namespace 丢弃");
    assert(out.includes(`${P} .q`), "后续规则正常");
}
{
    const css = ".a { color: red; .b { color: blue } }"; // CSS Nesting
    const out = scopeUserCss(css);
    assert(out.includes("color: red") && !out.includes("color: blue"), "嵌套规则块整块丢弃（不支持 Nesting）");
}

console.log("scopeUserCss — 注释与残片：");
{
    const css = "/* header comment */ .c1 { /* inline */ color: red }";
    const out = scopeUserCss(css);
    assert(out.includes(`${P} .c1`) && out.includes("color: red"), "注释剔除后规则正常");
    assert(!out.includes("header comment"), "注释内容不残留");
}
{
    const out = scopeUserCss(".tail { color: red } /* 未闭合说明");
    assert(out.includes(`${P} .tail`), "尾部注释残片不影响规则");
}
{
    const out = scopeUserCss("   \n  ");
    assert(out.trim() === "", "空白输入输出为空");
}

// ============================================================================
console.log("\nfilterDeclarations / filterInlineStyle — 黑名单：");
{
    assert(filterDeclarations("position: fixed; color: red").length === 1
        && filterDeclarations("position: fixed; color: red")[0] === "color: red",
        "position:fixed 丢弃、其余保留");
    assert(filterDeclarations("position: absolute; inset: 0").length === 0, "position:absolute + inset 丢弃");
    assert(filterDeclarations("position: sticky; z-index: 9").length === 0, "position:sticky + z-index 丢弃");
    assert(filterInlineStyle("position: relative").includes("position: relative"), "position:relative 保留");
    assert(filterDeclarations("position: static").length === 1, "position:static 保留");
    assert(filterDeclarations("top: 10px; left: 0; right: 0; bottom: 0").length === 0, "top/left/right/bottom 丢弃");
}
{
    assert(filterDeclarations("background: url(javascript:alert(1))").length === 0, "url(javascript:) 丢弃");
    assert(filterDeclarations("width: expression(alert(1))").length === 0, "expression() 丢弃");
    assert(filterDeclarations("behavior: url(#default#time2)").length === 0, "behavior 丢弃");
    assert(filterDeclarations("color: red; -moz-binding: url(x.xml#b)").length === 1, "-moz-binding 丢弃、其他保留");
}
{
    assert(filterDeclarations('background-image: url("https://evil.example/t.png")').length === 0, "外发 url 丢弃");
    assert(filterDeclarations("background-image: url(//evil.example/t.png)").length === 0, "协议相对 url 丢弃");
    assert(filterDeclarations("background: url(../../etc/passwd) no-repeat").length === 0, "相对路径 url 丢弃");
    assert(filterDeclarations("background-image: url(data:image/png;base64,AA)").length === 1, "data: url 保留");
    assert(filterDeclarations("mask: url(#svg-mask)").length === 1, "url(#fragment) 本地引用保留");
    assert(filterDeclarations("background: image-set('https://evil.example/a' 1x)").length === 0, "image-set() 远程丢弃");
}

console.log("filterDeclarations — 保留与格式：");
{
    const out = filterInlineStyle("color: #f00; font-size: 14px !important");
    assert(out.includes("color: #f00"), "颜色声明保留");
    assert(out.includes("!important"), "!important 保留");
}
{
    const out = filterInlineStyle("  COLOR : Red ");
    assert(out === "color: Red", "属性名小写化 + 空白规整（value 保留原大小写）");
}
{
    const out = filterDeclarations("content: 'a;b'; color: green");
    assert(out.length === 2 && out[0].includes("'a;b'"), "字符串内分号不破坏声明分割");
}
{
    const out = filterDeclarations("background: url(data:image/gif;base64,R0) center");
    assert(out.length === 1, "data url 含分号（base64）不被分号误分割");
}
{
    assert(filterDeclarations("transform: rotate(45deg); transition: all .2s").length === 2, "transform/transition 保留");
    assert(filterDeclarations("--brand: #0ff; color: var(--brand)").length === 2, "CSS 变量定义与引用保留");
    assert(filterDeclarations("a{b:c}").length === 0, "花括号残块丢弃（Nesting 防御）");
}

// ============================================================================
console.log("\nextractStyleBlocks / buildUserStyleTag：");
{
    const src = '<p>前</p><style>a { color: red }</style><p>后</p>';
    const { html, css } = extractStyleBlocks(src);
    assert(!/<style/i.test(html) && html.includes("<p>前</p>") && html.includes("<p>后</p>"), "style 块摘除、其余保留");
    assert(css === "a { color: red }", "CSS 内容完整提取");
}
{
    const { css } = extractStyleBlocks('<style media="print">b{c:d}</style><STYLE>e{f:g}</STYLE>');
    assert(css.split("\n").length === 2, "多个 style 块（含大写标签）全部提取");
}
{
    const tag = buildUserStyleTag("p { color: red }");
    assert(tag.startsWith('<style data-user-css="1">') && tag.endsWith("</style>"), "输出带 data-user-css 标记的 style 标签");
    assert(tag.includes(`${P} p`), "输出内容已前缀化");
}
{
    assert(buildUserStyleTag("@import url(x); /* nothing */") === "", "无有效规则时输出空串");
}
{
    const tag = buildUserStyleTag('a[href^="</style><img src=x onerror=alert(1)>"] { color: red }');
    assert(!tag.toLowerCase().includes("</style><img"), "未转义的 </style><img 闭合串不存在（防提前闭合 style 注入）");
    assert(tag.includes("<\\/style"), "逃逸以 \\/ 形式落地（CSS 合法转义）");
    assert(tag.includes(`${P} a[href^=`) && tag.includes("{ color: red }"), "含逃逸字符的规则仍正常输出");
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
