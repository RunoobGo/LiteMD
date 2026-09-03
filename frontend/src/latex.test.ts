// latex.test.ts — LaTeX 公式渲染单元测试
//
// 覆盖三类风险：
//   1. 正确性 —— 公式被渲染、且不被 marked 当作 markdown 语法破坏
//   2. 边界   —— 代码块 / 行内代码 / 转义符 / 货币写法不得误判
//   3. 安全   —— KaTeX trust:false 下的注入面，以及占位符还原的模式安全

import { extractLatex, restoreLatex, renderFormula, hasLatex } from "./latex";
import { renderMarkdown } from "./preview";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
    if (cond) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg); }
}

const hasKatex = (html: string) => html.includes("katex");
const hasDisplay = (html: string) => html.includes("katex-display");

// ============================================================================
console.log("基础渲染：");
assert(hasKatex(renderMarkdown("$x^2$")), "行内公式 $x^2$ 渲染出 KaTeX 结构");
assert(!hasDisplay(renderMarkdown("$x^2$")), "行内公式不产生 katex-display");
assert(hasDisplay(renderMarkdown("$$E=mc^2$$")), "块级公式 $$E=mc^2$$ 产生 katex-display");
assert(renderMarkdown("plain text").includes("plain text"), "无公式文档不受影响");
assert(!hasKatex(renderMarkdown("plain text")), "无公式文档不引入 katex 结构");

// 公式内部的下划线/星号不得被 marked 当成强调语法
const subHtml = renderMarkdown("$a_i * b_j$");
assert(!subHtml.includes("<em>"), "公式内 a_i * b_j 不被解析为 <em> 斜体");
assert(!subHtml.includes("<strong>"), "公式内不被解析为 <strong>");
assert(hasKatex(subHtml), "公式内特殊字符仍能正常渲染");

// 常见数学命令
assert(hasKatex(renderMarkdown("$\\frac{a}{b}$")), "\\frac{}{} 正常渲染");
assert(hasKatex(renderMarkdown("$\\sum_{i=1}^{n} x_i$")), "\\sum 上下标正常渲染");
assert(hasKatex(renderMarkdown("$$\\int_0^\\infty e^{-x^2}dx = \\frac{\\sqrt{\\pi}}{2}$$")), "复杂积分公式正常渲染");
assert(hasKatex(renderMarkdown("$\\text{中文}$")), "\\text{} 中文正常渲染");

// ============================================================================
console.log("\n代码块豁免：");
const fenced = renderMarkdown("```\n$x^2 + y^2$\n```");
assert(!hasKatex(fenced), "围栏代码块内的 $...$ 不渲染");
assert(fenced.includes("x^2 + y^2"), "围栏代码块内容原样保留");
assert(fenced.includes("<pre>"), "围栏代码块仍是 <pre>");

const fencedBlock = renderMarkdown("```math\n$$E=mc^2$$\n```");
assert(!hasKatex(fencedBlock), "围栏代码块内的 $$...$$ 不渲染");

const inlineCode = renderMarkdown("`$x^2$`");
assert(!hasKatex(inlineCode), "行内代码内的 $...$ 不渲染");
assert(inlineCode.includes("<code>"), "行内代码仍是 <code>");

// 代码块与公式混排：各归各位
const mixed = renderMarkdown("公式 $a+b$ 与代码 `$c+d$`");
assert(hasKatex(mixed), "混排：正文公式被渲染");
assert(mixed.includes("c+d"), "混排：行内代码内容保留");
const katexCount = (mixed.match(/class="katex"/g) || []).length;
assert(katexCount === 1, `混排：仅渲染 1 个公式（实际 ${katexCount}）`);

// ============================================================================
console.log("\n误判防护：");
assert(!hasKatex(renderMarkdown("价格是 \\$100 元")), "转义 \\$100 不渲染为公式");
assert(renderMarkdown("价格是 \\$100 元").includes("$100"), "转义 \\$ 还原为字面量 $100");
assert(!hasKatex(renderMarkdown("价格 $100 和 $200 元")), "货币写法 $100 和 $200 不误判为公式");
assert(!hasKatex(renderMarkdown("$ 100 $")), "定界符内侧为空白时不视为公式");
assert(hasKatex(renderMarkdown("$x$")), "单字符公式 $x$ 正常渲染");

// ============================================================================
console.log("\n安全（KaTeX trust:false）：");
// trust:false 会禁用 \href / \url / \htmlClass 等可注入 HTML 的命令
// 注：被拒绝的命令源码会留在 MathML 的 <annotation> 里（纯文本，供用户复制后
// 修正公式），这是 KaTeX 的正常设计 —— 关键是它不构成可点击链接。
const hrefAttack = renderMarkdown("$\\href{javascript:alert(1)}{click}$");
assert(!/<a[\s>]/i.test(hrefAttack), "trust:false：\\href 不产出 <a> 标签");
assert(!/href\s*=/i.test(hrefAttack), "trust:false：\\href 不产出 href 属性（无可执行链接）");

const htmlClassAttack = renderMarkdown("$\\htmlClass{evil}{x}$");
assert(!/class="[^"]*evil/.test(htmlClassAttack), "trust:false：\\htmlClass 不注入自定义 class");

const scriptInMath = renderMarkdown("$<script>alert(1)</script>$");
assert(!/<script/i.test(scriptInMath), "公式内 <script> 不产出 script 标签");

// 宏展开炸弹（\edef 递归）应被 maxExpand 挡住，不挂死
const bombStart = Date.now();
renderMarkdown("$\\edef\\a{\\a}\\a$");
assert(Date.now() - bombStart < 5000, "宏展开炸弹被 maxExpand 限制（未长时间阻塞）");

// 占位符还原的模式安全：公式内容含 `$&` 时不应被当成替换模式
const ampFormula = renderFormula({ tex: "$&$", display: false });
assert(ampFormula.includes("$&"), "公式含 $& 时原样输出，未被当作替换模式");

// ============================================================================
console.log("\n健壮性：");
assert(typeof renderMarkdown("$\\frac{1}{$") === "string", "未闭合公式不抛异常");
assert(typeof renderMarkdown("$$") === "string", "孤立 $$ 不抛异常");
assert(typeof renderMarkdown("$$$") === "string", "孤立 $$$ 不抛异常");
assert(renderMarkdown("") === "", "空输入返回空串");
const brokenHtml = renderMarkdown("$\\frac{1}{$");
assert(brokenHtml.length > 0, "语法错误公式降级为可见内容而非空白");
assert(!/<script/i.test(brokenHtml), "错误降级路径不含 script");

// hasLatex 的 lastIndex 幂等（带 g 的正则跨调用状态残留修复）
const probe = "$$a$$ $b$";
const first = hasLatex(probe);
const second = hasLatex(probe);
assert(first === true && second === true, `hasLatex 跨调用结果稳定（${first}/${second}）`);

// ============================================================================
console.log("\n与既有特性共存：");
const calloutMath = renderMarkdown("> [!note] 说明\n> 公式 $E=mc^2$ 很重要");
assert(hasKatex(calloutMath), "callout 体内的公式被渲染");
assert(calloutMath.includes("callout-note"), "callout 结构未被破坏");

const wikiMath = renderMarkdown("见 [[Note A]] 与公式 $x^2$");
assert(hasKatex(wikiMath), "wiki-link 与公式共存：公式被渲染");
assert(wikiMath.includes("wiki-link"), "wiki-link 与公式共存：链接未被破坏");

// 提取/还原的往返一致性（纯公式 + 围栏代码块互不干扰）
const src = "前 $a$ 后 $$c$$\n```\n$b$\n```";
const { text, ext, re } = extractLatex(src);
assert(!text.includes("$a$"), "提取后行内公式 $a$ 已替换为占位符");
assert(!text.includes("$$c$$"), "提取后块级公式 $$c$$ 已替换为占位符");
assert(text.includes("$b$"), "围栏内 $b$ 仍为字面量（原样留给 marked）");
const roundTrip = restoreLatex(text, ext, re);
assert(roundTrip.includes("```"), "还原后代码块原文恢复");

// ============================================================================
// 安全加固回归测试（占位符防伪 + ReDoS 守卫）
// ============================================================================

// 占位符伪造：用户文本中包含占位符形态的字符串，提取阶段必须被剥除
{
    // 真实 wiki-link 攻击：别名中含占位符形态字符串
    const attack = "$x$\n\n[[Note|alias-LTMDPHLX0ZX]]";
    const r = renderMarkdown(attack);
    // data-wikilink 属性值不应被 KaTeX HTML 突破
    const m = r.match(/data-wikilink="([^"]*)"/);
    assert(m !== null && m[1] === "Note",
           "占位符伪造：wiki-link 别名内的占位符形态被剥除，属性值仅 Note");
    // 既含 <math>（真公式已渲染）又含 wiki-link（剥除后保留）说明两条路径都工作
    assert(r.includes("<math") && m !== null,
           "占位符伪造：KaTeX 输出只能在文本节点，不可进入属性上下文");
    const extArr = extractLatex(attack).ext.formulas;
    assert(extArr.length === 1,
           "占位符伪造：仅第一个真公式被提取，伪造占位符不进入公式表");

    // img 标题属性同样应被剥除
    const guess = "$x$\n\n![a](https://e.com/x.png \"LTMDPHLXabc1230ZX\")";
    const { ext: ext2 } = extractLatex(guess);
    assert(ext2.formulas.length === 1,
           "占位符伪造：img 标题属性内的占位符形态不进入公式表");
}

// 占位符盐：会话级恒定（审查 P1-3 块缓存前提）—— 同一文本跨渲染产生
// 相同占位符，preview 的分块缓存才能命中；盐本身仍是进程内随机值
// （用户编写文档时不可得知），且防伪核心层（PH_LIKE_RE 预剥除）与盐无关
{
    const s1 = extractLatex("$x$").re.source;
    const s2 = extractLatex("$x$").re.source;
    assert(s1 === s2, "占位符盐会话内恒定（同一文本跨渲染占位符稳定）");
    assert(s1.startsWith("LTMDPHLX") && s1.includes("(\\d+)ZX"),
           "占位符仍为随机盐形态（LTMDPHLX{盐}(序号)ZX）");
}

// 还原只在文本节点（> 与 < 之间）替换 —— 即便剥除逻辑被绕过，属性也不被突破
{
    // 手动构造一个含字面占位符的 HTML（模拟剥除失效的极端边界）
    const html = `<a data-wikilink="LTMDPHLX0ZX">link</a>`;
    // 注意：extractLatex 返回的 re 只匹配带本次盐的占位符，所以 LTMDPHLX0ZX
    // 不会被识别为占位符 → 不会还原。属性值保留原样 → 安全。
    const { ext, re } = extractLatex("$x$");
    const out = restoreLatex(html, ext, re);
    const m = out.match(/data-wikilink="([^"]*)"/);
    assert(m !== null && m[1].includes("LTMDPHLX"),
           "还原阶段：属性值不被还原（本批次盐不匹配的占位符原样保留）");
}

// FENCE ReDoS 守卫（旧版跨行正则的二次复杂度回归）
{
    const attack = "```js\n".repeat(10000);
    const t0 = Date.now();
    extractLatex(attack);
    assert(Date.now() - t0 < 500,
           `FENCE ReDoS：10000 行未闭合围栏 < 500ms（实测 ${Date.now() - t0}ms）`);
}

// 未闭合围栏：findFenceRanges 把整段判为代码区（与 marked 一致）
{
    const md = "前\n```\n$x$\n后";
    const { text } = extractLatex(md);
    assert(text.includes("$x$"), "未闭合围栏：公式被当作代码保留");
}

// ============================================================================
// 闸门：逃逸 maxSize 的命令 + 异常长度单位 + 超大公式 → 降级为 latex-error，
// 不送进 KaTeX（防止撑爆 DOM / 拖垮预览）
console.log("\n闸门（逃逸 maxSize）：");
{
    const cases: Array<{ name: string; tex: string }> = [
        { name: "\\raisebox", tex: "\\raisebox{0pt}{100pt}{x}" },
        { name: "\\scalebox", tex: "\\scalebox{100}{x}" },
        { name: "\\resizebox", tex: "\\resizebox{100pt}{!}{x}" },
        { name: "\\fbox", tex: "\\fbox{a \\fbox{b \\fbox{c \\fbox{d}}}}" },
        { name: "\\colorbox", tex: "\\colorbox{red}{x}" },
        { name: "嵌套 phantom", tex: "a\\phantom{b\\phantom{c\\phantom{d}}}" },
        { name: "异常长度单位 (99999em)", tex: "x^{99999em}" },
        { name: "超大公式 8KB+", tex: "x" + "+y".repeat(5000) },
    ];
    for (const c of cases) {
        const out = renderMarkdown(`$${c.tex}$`);
        assert(out.includes("latex-error"),
               `${c.name} → 降级为 latex-error，不送进 KaTeX`);
    }
}
// 反向用例：普通公式不能被误判为过重
{
    const out = renderMarkdown("$a + b$");
    assert(out.includes("katex"), "普通公式 $a + b$ 仍走 KaTeX 渲染");
    assert(!out.includes("latex-error"), "普通公式不触发 latex-error 降级");
}

// ============================================================================
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
