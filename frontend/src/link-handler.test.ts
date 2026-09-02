// link-handler.test.ts — 链接分类与标题锚点 id 生成
import { classifyHref, slugifyHeading, assignHeadingIds } from "./link-handler";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
    if (cond) {
        pass++;
        console.log(`  ✅ ${msg}`);
    } else {
        fail++;
        console.error(`  ❌ ${msg}`);
    }
}
function eq(actual: unknown, expected: unknown, msg: string) {
    assert(actual === expected, `${msg}（实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}）`);
}

console.log("== classifyHref: 分类 ==");

const cases: Array<[string, string]> = [
    ["https://example.com", "external"],
    ["HTTPS://EXAMPLE.COM/a", "external"],
    ["http://a.b/c?d=1#e", "external"],
    ["mailto:a@b.com", "mail"],
    ["tel:+8613800000000", "mail"],
    ["#标题", "anchor"],
    ["#%E6%A0%87%E9%A2%98", "anchor"],
    ["../../文档名", "local"],
    ["../parent.md", "local"],
    ["./sibling.md", "local"],
    ["note.md", "local"],
    ["sub/note.md", "local"],
    ["C:/docs/a.md", "local"],
    ["C:\\docs\\a.md", "local"],
    ["file:///C:/docs/a.md", "local"],
    ["//server/share/a.md", "local"],
    ["javascript:alert(1)", "unsafe"],
    ["data:text/html;base64,xxx", "unsafe"],
    ["vbscript:msgbox(1)", "unsafe"],
    ["", "unsafe"],
    ["   ", "unsafe"],
];
for (const [href, expected] of cases) {
    eq(classifyHref(href).kind, expected, `classifyHref(${JSON.stringify(href)}) → ${expected}`);
}

console.log("== classifyHref: 锚点与查询切分 ==");

const anchorCase = classifyHref("sub/b.md?x=1#sec");
eq(anchorCase.target, "sub/b.md", "标准顺序 ?query#fragment：target 正确");
eq(anchorCase.anchor, "sec", "标准顺序 ?query#fragment：anchor 正确");

const anchorOnly = classifyHref("#sec?x=1");
eq(anchorOnly.anchor, "sec?x=1", "fragment 内的 ? 属于锚点（符合 URL 规范）");

const externalAnchor = classifyHref("https://a.com/p?q=1#frag");
eq(externalAnchor.kind, "external", "外链带锚点仍是 external");
eq(externalAnchor.anchor, "frag", "外链锚点被正确切出");

console.log("== slugifyHeading ==");

eq(slugifyHeading("Hello World"), "hello-world", "英文标题 → 小写连字符");
eq(slugifyHeading("  空格  很多  "), "空格-很多", "空白折叠为单个连字符");
eq(slugifyHeading("C++ 入门 (二)"), "c-入门-二", "标点被剥离");
eq(slugifyHeading("二级标题"), "二级标题", "中文标题保留原文");

console.log("== assignHeadingIds ==");

const ids = assignHeadingIds(["概述", "概述", "安装", "概述"]);
eq(ids.join(","), "概述,概述-2,安装,概述-3", "重复标题依次加 -2 / -3 后缀");
eq(assignHeadingIds(["!!!", "???"]).join(","), "section-1,section-2", "纯标点标题回退为 section-N");
eq(new Set(assignHeadingIds(["a", "a", "a"])).size, 3, "生成的 id 互不重复");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
