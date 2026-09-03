// latex.ts — LaTeX 数学公式渲染（KaTeX）
//
// 设计要点
// --------
// 1. **占位符方案**：公式在 marked 之前抽成占位符，在 DOMPurify 之后再还原。
//    原因有二：
//      a) marked 会破坏公式内部的下划线/星号/反斜杠（如 `a_i * b_j` 变成斜体）；
//      b) DOMPurify 会剥离 KaTeX 必需的 `style` 属性与 MathML 标签，
//         若在清洗前注入公式，渲染结果会被打残。
//
// 2. **代码块豁免**：``` 围栏块、`行内代码`、以及 `\$` 转义先被抽走，
//    因此代码块里的 `$` 不会被误当公式边界（这是同类实现的常见 bug）。
//
// 3. **安全**：KaTeX 以 `trust: false` 运行 —— 禁用 \href / \url / \htmlClass /
//    \htmlStyle / \htmlData / \includegraphics 等可注入 HTML 的命令，输出仅为
//    纯 MathML + span，无 XSS 面。另设 maxSize / maxExpand 防御宏展开炸弹。
//
// 4. **占位符防伪**：占位符带不可预测的随机盐（会话级，见 extractLatex
//    注释），且提取阶段会先把用户文本中所有「占位符形态」的字符串剥成
//    空串。双保险使攻击者无法在文档中伪造占位符触发还原阶段的属性
//    上下文注入（剥除层与盐无关，独立成立）。
//
// 5. **FENCE / inRanges 的线性实现**：旧版用跨行懒惰正则 FENCE_RE，在
//    「多个未闭合围栏」输入下 O(n²)（每翻倍输入耗时涨 4 倍）；inRanges
//    对每个新区间线性扫描所有旧区间，豁免区多时退化。本版分别改用按行
//    状态机与按起点排序+游标二分，单次渲染最坏 O(n)。

import katex from "katex";
import { escapeHtml } from "./html";

export interface LatexFormula {
    /** 公式源码（不含定界符） */
    tex: string;
    /** true = $$块级公式$$（居中独占行）；false = $行内公式$ */
    display: boolean;
}

/** 一次提取的产物 */
export interface LatexExtraction {
    formulas: LatexFormula[];
}

const LATEX_PREFIX = "LTMDPHLX";
const LATEX_SUFFIX = "ZX";

/** 生成随机盐（每次提取调用一次）：使占位符不可预测，防伪造。 */
function newSalt(): string {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** 匹配用户文本中所有「占位符形态」（无论盐是什么），用于提取前剥除。 */
const PH_LIKE_RE = /LTMDPHLX[A-Za-z0-9]*\d+ZX/g;

/** 文本区间 [start, end) */
type Range = [number, number];

/** 行内代码 */
const INLINE_CODE_RE = /`[^`\n]+`/g;
/** 块级公式 $$...$$ */
const BLOCK_MATH_RE = /\$\$([\s\S]+?)\$\$/g;
/**
 * 行内公式 $...$
 * 约束：紧邻定界符处不得为空白 —— 避免 `$100 和 $200 元` 这类货币写法被误判。
 *   - `[^\s$][^$\n]*?[^\s$]`  多字符，首尾非空白
 *   - `[^\s$]`                单字符（如 `$x$`）
 */
const INLINE_MATH_RE = /\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g;

/**
 * 找出所有围栏代码块（含未闭合的围栏——视作从开栏到文末为代码区）。
 *
 * 按行扫描、状态机实现，O(n)。旧版用跨行懒惰正则 O(n²)，
 * 输入翻倍耗时涨 4 倍（多个未闭合围栏即可触发）。
 */
function findFenceRanges(md: string): Range[] {
    const ranges: Range[] = [];
    const lines = md.split("\n");
    let offset = 0;
    let open: { fence: string; start: number } | null = null;
    for (const line of lines) {
        const m = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
        if (open) {
            // 闭栏：同类 fence、长度 ≥ 开栏、其后只有空白
            if (m && m[2][0] === open.fence[0] && m[2].length >= open.fence.length && m[3].trim() === "") {
                ranges.push([open.start, offset + line.length]);
                open = null;
            }
        } else if (m) {
            open = { fence: m[2], start: offset };
        }
        offset += line.length + 1;
    }
    // 未闭合围栏：把「开栏到文末」整体判为代码区
    if (open) ranges.push([open.start, md.length]);
    return ranges;
}

/** 单个公式 → KaTeX HTML。渲染失败时降级为可读的错误提示，不抛异常。 */
export function renderFormula(f: LatexFormula): string {
    // 公式缓存（审查 🟡-7）：连续输入时每次全量重渲都会重算所有公式，
    // 同一源码+模式的结果是确定的，纯浪费。
    // 审计 R2-F2：原实现容量 500 满时 clear() 整清，下一次 render 会让
    // 整文档所有公式一次性重算（thundering herd）。改为 LRU：删最老再
    // 插入，命中率不被一次性清空打断（与 preview.ts / mermaid.ts 一致）。
    const key = `${f.display ? "D" : "I"}\u0000${f.tex}`;
    const hit = formulaCache.get(key);
    if (hit !== undefined) return hit;
    const html = renderFormulaUncached(f);
    if (formulaCache.size >= FORMULA_CACHE_MAX) {
        // Map 保持插入顺序，keys().next() 取最早插入的 key
        const oldest = formulaCache.keys().next().value;
        if (oldest !== undefined) formulaCache.delete(oldest);
    }
    formulaCache.set(key, html);
    return html;
}

const FORMULA_CACHE_MAX = 500;
const formulaCache = new Map<string, string>();

/** 公式渲染的资源/特征闸门：超过任一阈值直接降级，避免拖垮预览。 */
const FORMULA_MAX_BYTES = 8 * 1024; // 8KB；超过基本是恶意/粘贴失误
/** 逃逸 maxSize 控制的命令：本身合法，但可让 KaTeX 渲染出不受约束的尺寸/层叠内容。 */
const ESCAPE_MAX_SIZE_COMMANDS = [
    "\\raisebox",
    "\\scalebox",
    "\\resizebox",
    "\\reflectbox",
    "\\rotatebox",
    "\\fbox",
    "\\boxed",
    "\\colorbox",
    "\\fcolorbox",
    "\\phantom",
    "\\hphantom",
    "\\vphantom",
];
const ESCAPE_MAX_SIZE_RE = new RegExp(
    `(?:${ESCAPE_MAX_SIZE_COMMANDS.map((c) => c.replace(/\\/g, "\\\\")).join("|")})`,
    "i",
);
/** 纯长度类单位注入（99999em / 99999ex / 1e6pt 等）也可让排版逃出 maxSize。 */
const HUGE_LENGTH_RE = /-?\d{4,}\s*(?:em|ex|pt|px|pc|in|cm|mm|mu)\b/i;

function isTooHeavy(tex: string): boolean {
    if (tex.length > FORMULA_MAX_BYTES) return true;
    if (ESCAPE_MAX_SIZE_RE.test(tex)) return true;
    if (HUGE_LENGTH_RE.test(tex)) return true;
    return false;
}

function renderFormulaUncached(f: LatexFormula): string {
    // 闸门：超过尺寸/含逃逸 maxSize 命令/含异常长度单位 → 降级为可读错误，不送进 KaTeX
    if (isTooHeavy(f.tex)) {
        return `<code class="latex-error">${escapeHtml(f.tex.slice(0, 200))}${f.tex.length > 200 ? "…" : ""}</code>`;
    }
    // 审计 R2-F11：errorColor 硬编码暗红在亮主题对比度差；读 CSS 变量
    // 走主题系统，缺变量时回退到 oneDark 红色。
    const errorColor = (typeof getComputedStyle === "function"
        ? getComputedStyle(document.documentElement).getPropertyValue("--md-error").trim()
        : "") || "#e06c75";
    try {
        return katex.renderToString(f.tex, {
            displayMode: f.display,
            throwOnError: false,
            errorColor,
            strict: false,
            trust: false,
            maxSize: 50,
            maxExpand: 1000,
            output: "htmlAndMathml",
        });
    } catch {
        // 极端兜底：KaTeX 自身崩溃时也不应让整个预览挂掉
        return `<code class="latex-error">${escapeHtml(f.tex)}</code>`;
    }
}

/**
 * 找出所有「豁免区间」：围栏代码块、行内代码、以及转义的 `\$`。
 *
 * 围栏区间先由 findFenceRanges 按行扫描产出（已按起点升序）。
 * 行内代码与 `\$` 区间也按起点升序加入；ranges 整体单调 → O(n) 摊销。
 *
 * 注意这里**只标记位置、不替换内容** —— 代码块必须原样留给 marked，
 * 否则 marked 看不到反引号，``` 就不会被渲染成 <pre><code>。
 */
function findExemptRanges(md: string): Range[] {
    const ranges: Range[] = findFenceRanges(md);
    let m: RegExpExecArray | null;

    const inline = new RegExp(INLINE_CODE_RE.source, "g");
    while ((m = inline.exec(md))) {
        insertSortedRange(ranges, [m.index, m.index + m[0].length]);
    }

    // `\$` 是「字面量美元符」，不是公式边界；原样留给 marked 处理转义
    const escaped = /\\\$/g;
    while ((m = escaped.exec(md))) {
        insertSortedRange(ranges, [m.index, m.index + m[0].length]);
    }

    return ranges;
}

/** 将 [s,e] 插入已按起点升序的区间数组（合并重叠区间）。O(n) 摊销。 */
function insertSortedRange(ranges: Range[], [s, e]: Range): void {
    let i = 0;
    while (i < ranges.length && ranges[i][0] < s) i++;
    if (i === ranges.length) {
        ranges.push([s, e]);
        return;
    }
    // 与前一个区间重叠/相邻 → 合并
    if (i > 0 && ranges[i - 1][1] >= s) {
        ranges[i - 1][1] = Math.max(ranges[i - 1][1], e);
        while (i < ranges.length && ranges[i][0] <= ranges[i - 1][1]) {
            ranges[i - 1][1] = Math.max(ranges[i - 1][1], ranges[i][1]);
            ranges.splice(i, 1);
        }
        return;
    }
    if (ranges[i][0] < e) {
        // 后续区间起点落在新区间内 → 合并
        ranges.splice(i, 1, [s, Math.max(e, ranges[i][1])]);
    } else {
        ranges.splice(i, 0, [s, e]);
    }
}

/** 在一段「非豁免」文本中提取公式并替换成占位符 */
function extractInSegment(seg: string, formulas: LatexFormula[], ph: (n: number) => string): string {
    // 块级先走，避免 `$$x$$` 被行内规则从中间切开
    let s = seg.replace(BLOCK_MATH_RE, (_m, tex: string) => {
        formulas.push({ tex: tex.trim(), display: true });
        return ph(formulas.length - 1);
    });
    s = s.replace(INLINE_MATH_RE, (_m, tex: string) => {
        formulas.push({ tex, display: false });
        return ph(formulas.length - 1);
    });
    return s;
}

/**
 * 抽取文档中的公式，替换为占位符。同时返回本次占位符的正则（用于还原）。
 *
 * 调用方应在 **marked 之前** 调用本函数，并在 **DOMPurify 之后** 用
 * 返回的 `re` 调用 `restoreLatex`，否则公式会被 marked 破坏或被 DOMPurify
 * 清洗掉。
 *
 * 盐为**会话级**（进程生命周期内恒定，懒初始化一次）——审查 P1-3 的
 * 块缓存要求同一文本跨渲染产生相同占位符，若每次调用换盐，含公式
 * 文档的 token.raw 永不稳定、缓存永不命中。防伪不受影响：
 *   a) 会话盐仍是进程启动后不可预测的随机值（用户编写文档时无法得知）；
 *   b) 防伪造的核心层——「提取前剥除用户文本中所有占位符形态」——与盐
 *      无关，独立成立（见下方 PH_LIKE_RE 剥除）。
 */
let sessionSalt: string | null = null;

export function extractLatex(md: string): { text: string; ext: LatexExtraction; re: RegExp } {
    const formulas: LatexFormula[] = [];
    if (sessionSalt === null) sessionSalt = newSalt();
    const salt = sessionSalt;
    const ph = (n: number) => `${LATEX_PREFIX}${salt}${n}${LATEX_SUFFIX}`;
    const re = new RegExp(`${LATEX_PREFIX}${salt}(\\d+)${LATEX_SUFFIX}`, "g");

    // 剥除用户文本中所有「占位符形态」（无论盐是什么）—— 即使攻击者猜中
    // 盐，也无法在文档里构造出可还原的占位符
    const cleaned = md.replace(PH_LIKE_RE, "");

    const ranges = findExemptRanges(cleaned);

    let out = "";
    let cursor = 0;
    for (const [start, end] of ranges) {
        out += extractInSegment(cleaned.slice(cursor, start), formulas, ph);
        out += cleaned.slice(start, end); // 豁免区原样保留
        cursor = end;
    }
    out += extractInSegment(cleaned.slice(cursor), formulas, ph);

    return { text: out, ext: { formulas }, re };
}

/** 单个公式 → KaTeX HTML。渲染失败时降级为可读的错误提示，不抛异常。
 *  实现见文件上方 renderFormula（含缓存）。 */
/**
 * 还原公式占位符。
 *
 * **只在 > 与 < 之间的文本节点替换**，严格不触碰属性上下文：
 *   攻击者若在文档中伪造 `LTMDPHLX...ZX` 形态字符串，意图借此突破
 *   DOMPurify 的属性白名单把 KaTeX HTML 注入到属性值里 —— 此实现
 *   因占位符只在文本片段内被替换而天然不成立。
 *
 * 代码块不参与此流程 —— 它们在提取阶段就被整体跳过（而非替换），
 * 因此 marked 早已把 ``` 正常渲染成 <pre><code>。
 *
 * 注：攻击者若在代码块里手打占位符形态（实际场景极罕见），占位符会
 * 在提取阶段被剥成空串；新盐 + 剥除用户占位符形态的双保险使该路径
 * 不构成安全威胁，仅是「用户文档被误解释为公式」的可读性影响。
 */
export function restoreLatex(html: string, ext: LatexExtraction, re: RegExp): string {
    return html.replace(/(>)([^<]*)(<)/g, (_m, a: string, text: string, b: string) =>
        a + text.replace(re, (ph, idx: string) => {
            const f = ext.formulas[Number(idx)];
            return f ? renderFormula(f) : ph;
        }) + b,
    );
}

/**
 * 检测文档是否含公式（用于按需加载样式 / 编辑器提示，暂未使用）。
 *
 * 注意：这里刻意用不带 `g` 标志的独立正则 —— 带 g 的正则对象会残留
 * lastIndex 状态，跨调用做 test 会从上次的断点继续匹配，导致漏判。
 */
const BLOCK_MATH_TEST_RE = /\$\$([\s\S]+?)\$\$/;
const INLINE_MATH_TEST_RE = /\$([^\s$](?:[^$\n]*?[^\s$])?)\$/;

export function hasLatex(md: string): boolean {
    return BLOCK_MATH_TEST_RE.test(md) || INLINE_MATH_TEST_RE.test(md);
}