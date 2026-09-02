// toc.test.ts — 文档大纲解析的单元测试
//
// 守卫点（同类实现最容易翻车的地方）：
//   - 围栏代码块里的 `# 注释` 不能被当成标题
//   - YAML frontmatter 里的 `key: value` 不能被 Setext 规则误判成 H2
//   - `#hashtag` / `#######` 不是标题
//   - 标题文本需剥掉行内 Markdown 标记
//   - 层级跳变（H2 → H4）应正确嵌套而非丢节点

import { parseToc, buildTocTree } from "./toc";

let pass = 0; let fail = 0;
function assertEq(a: unknown, b: unknown, msg: string) {
    if (a === b) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg + " (want=" + JSON.stringify(b) + " got=" + JSON.stringify(a) + ")"); }
}

/** 取出 (level,line) 摘要，便于整体比对 */
const shape = (md: string) => parseToc(md).map((e) => `${e.level}:${e.line}`).join(",");

// ============================================================================
console.log("ATX 标题（层级与行号）：");
{
    assertEq(
        shape("# 一\n正文\n## 二\n### 三\n#### 四\n##### 五\n###### 六"),
        "1:1,2:3,3:4,4:5,5:6,6:7",
        "H1-H6 全部识别，行号从 1 开始且跳过正文行"
    );
    assertEq(shape("   ### 缩进三格"), "3:1", "允许最多 3 个前导空格（CommonMark）");
    assertEq(shape("#"), "1:1", "单独的 # 是合法 H1（文本为空）");
}

// ============================================================================
console.log("非标题（必须被排除）：");
{
    assertEq(shape("#hashtag"), "", "# 后无空格 → 不是标题，是话题标签");
    assertEq(shape("####### 七级"), "", "# 超过 6 个 → 不是标题（CommonMark 上限 H6）");
    assertEq(shape("正文一行"), "", "纯文本无标题");
    assertEq(shape(""), "", "空文档安全");
}

// ============================================================================
console.log("围栏代码块（最重要的一类误判）：");
{
    const md = [
        "# 真标题",
        "```bash",
        "# 这是 shell 注释，不是 H1",
        "echo hi",
        "```",
        "## 二级",
    ].join("\n");
    assertEq(shape(md), "1:1,2:6", "``` 围栏内的 # 注释被跳过");

    const md2 = [
        "# 真标题",
        "~~~",
        "# tilde 围栏内的注释",
        "~~~",
        "## 二级",
    ].join("\n");
    assertEq(shape(md2), "1:1,2:5", "~~~ 围栏同样生效");

    const md3 = [
        "# A",
        "````",
        "```",
        "# 内层 ``` 不能提前闭合外层围栏",
        "````",
        "# B",
    ].join("\n");
    assertEq(shape(md3), "1:1,1:6", "闭合围栏需长度 >= 开启围栏（长短围栏嵌套）");
}

// ============================================================================
console.log("YAML frontmatter：");
{
    const md = [
        "---",
        "title: 我的笔记",
        "tags: [a, b]",
        "---",
        "",
        "# 正文标题",
    ].join("\n");
    assertEq(shape(md), "1:6", "frontmatter 内的 `title: 值` 不被 Setext 规则误判为 H2");
    assertEq(parseToc(md)[0].text, "正文标题", "frontmatter 之后的首个标题正常解析");
}

// ============================================================================
console.log("Setext 标题：");
{
    const md = ["标题一", "======", "正文", "标题二", "------"].join("\n");
    assertEq(shape(md), "1:1,2:4", "=== → H1，--- → H2，且行号指向标题文本行");
    assertEq(parseToc(md)[1].text, "标题二", "Setext H2 文本取自上一行");
    // 单个 `-` 是列表项 / 分隔线歧义，按分隔线处理（见 toc.ts SETEXT_RE 注释）
    assertEq(shape(["项目A", "-", "项目B"].join("\n")), "", "单个 - 不触发 Setext H2");
}

// ============================================================================
console.log("标题文本清洗：");
{
    const cases: Array<[string, string, string]> = [
        ["# **加粗** 与 `代码`", "加粗 与 代码", "剥除加粗与行内代码"],
        ["## [链接](http://x.com)", "链接", "链接只保留文字"],
        ["### [[Wiki|别名]]", "别名", "wiki 双链取别名部分"],
        ["#### [[无别名]]", "无别名", "wiki 双链无别名时取本身"],
        ["##### 结尾井号 ###", "结尾井号", "剥除闭合 # 序列"],
        ["###### ![图](a.png) 标题", "图 标题", "图片语法只保留 alt"],
        ["# ~~删除~~ 线", "删除 线", "剥除删除线"],
        ["# <b>粗</b>", "粗", "剥除裸 HTML 标签"],
        ["# 转义 \\* 星号", "转义 * 星号", "反斜杠转义还原为字面字符"],
    ];
    for (const [input, want, name] of cases) {
        assertEq(parseToc(input)[0].text, want, name);
    }
}

// ============================================================================
console.log("buildTocTree（层级嵌套）：");
{
    const md = ["# A", "## A1", "#### A1a", "## A2", "# B"].join("\n");
    const tree = buildTocTree(parseToc(md));
    assertEq(tree.length, 2, "两个 H1 作为根节点");
    assertEq(tree[0].children.length, 2, "A 下挂 A1 与 A2");
    assertEq(tree[0].children[0].children[0].text, "A1a",
        "层级跳变 H2→H4 时 H4 直接挂在 H2 下，不制造 H3 占位节点");
    assertEq(tree[1].children.length, 0, "B 无子标题");

    // 逆序层级：H3 出现在 H1 之前时应被提升为根
    const jump = buildTocTree(parseToc("### 先出现\n# 后出现"));
    assertEq(jump.length, 2, "首个标题层级不是 H1 时各自成为根节点，不丢节点");
    assertEq(jump[0].text, "先出现", "保持原始顺序");
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
export {};
