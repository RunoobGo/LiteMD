// md-escape.test.ts — 图片插入 Markdown 转义的单元测试（#9 回归守卫）
//
// 覆盖：alt 转义、路径归一、百分号编码、组合输出。
// 守卫点：文件名含 ] / 路径含空格括号反斜杠时，生成的 Markdown 必须语法完整。

import { escapeImageAlt, normalizeImagePath, encodeImageUrl, buildImageMarkdown } from "./md-escape";

let pass = 0; let fail = 0;
function assertEq(a: unknown, b: unknown, msg: string) {
    if (a === b) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg + " (want=" + JSON.stringify(b) + " got=" + JSON.stringify(a) + ")"); }
}

// ============================================================================
console.log("escapeImageAlt（alt 转义）：");
{
    // 表驱动：[输入, 期望, 说明]
    const cases: Array<[string, string, string]> = [
        ["screenshot.png", "screenshot.png", "普通文件名原样保留"],
        ["shot [1].png", "shot \\[1\\].png", "方括号转义（破坏链接语法的主因）"],
        ["a\\b.png", "a\\\\b.png", "反斜杠本身先转义"],
        ["[v2] 截图.png", "\\[v2\\] 截图.png", "方括号与中文混排"],
        ["图 (1).png", "图 (1).png", "圆括号在 alt 中无需转义（CommonMark）"],
        ["", "", "空串安全"],
    ];
    for (const [input, want, name] of cases) {
        assertEq(escapeImageAlt(input), want, name);
    }
}

// ============================================================================
console.log("normalizeImagePath（分隔符归一）：");
{
    const cases: Array<[string, string, string]> = [
        ["assets\\img\\a.png", "assets/img/a.png", "Windows 反斜杠归一为正斜杠"],
        ["assets/img/a.png", "assets/img/a.png", "正斜杠原样保留"],
        ["C:\\Users\\just\\a.png", "C:/Users/just/a.png", "Windows 盘符路径归一"],
        ["", "", "空串安全"],
    ];
    for (const [input, want, name] of cases) {
        assertEq(normalizeImagePath(input), want, name);
    }
}

// ============================================================================
console.log("encodeImageUrl（百分号编码）：");
{
    const cases: Array<[string, string, string]> = [
        ["/docs/我的笔记/assets/a.png", "/docs/我的笔记/assets/a.png", "中文与正斜杠保持原样"],
        ["/docs/my notes/a.png", "/docs/my%20notes/a.png", "空格编码为 %20"],
        ["/docs/xx(1)/a.png", "/docs/xx%281%29/a.png", "括号编码，防链接目标截断"],
        ["/a\\b.png", "/a/b.png", "反斜杠先归一"],
        ["a%20b.png", "a%2520b.png", "字面 % 先编码（与已编码序列自洽）"],
        ["/docs/my notes (v2)/a.png", "/docs/my%20notes%20%28v2%29/a.png", "空格与括号混合"],
    ];
    for (const [input, want, name] of cases) {
        assertEq(encodeImageUrl(input), want, name);
    }
}

// ============================================================================
console.log("buildImageMarkdown（组合输出）：");
{
    assertEq(
        buildImageMarkdown("screenshot.png", "/docs/assets/1_screenshot.png"),
        "![screenshot.png](/docs/assets/1_screenshot.png)",
        "无特殊字符时输出标准语法"
    );
    assertEq(
        buildImageMarkdown("shot [1].png", "/docs/my notes (v2)/1_shot.png"),
        "![shot \\[1\\].png](/docs/my%20notes%20%28v2%29/1_shot.png)",
        "#9 回归：alt 含 ] 且路径含空格括号，链接语法完整"
    );
    assertEq(
        buildImageMarkdown("截图.png", "C:\\docs\\assets\\1_截图.png"),
        "![截图.png](C:/docs/assets/1_截图.png)",
        "Windows 路径归一为正斜杠"
    );
    // 语法完整性自检：生成的 Markdown 必须能被最简解析器还原出 alt 与 URL
    const md = buildImageMarkdown("a]b(c).png", "/p q/a.png");
    const m = /^!\[([\s\S]*)\]\(([\s\S]*)\)$/.exec(md);
    assertEq(m !== null, true, "输出匹配 ![alt](url) 整体结构");
    if (m) {
        assertEq(m[1], "a\\]b(c).png", "alt 部分被正确转义");
        assertEq(m[2], "/p%20q/a.png", "URL 部分被正确编码");
    }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
export {};
