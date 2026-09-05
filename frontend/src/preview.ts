// preview.ts — Markdown 实时预览 + XSS 防护
//
// 安全策略：
//   - DOMPurify 默认禁用危险标签：<script>, <iframe>, <object>, <embed>, on* 事件
//   - v0.2.7 内嵌 HTML/CSS：语义标签白名单扩充；style 属性经声明级过滤
//     hook 放行；<style> 块由 user-css.ts 作用域化到 .preview-content 后
//     重新注入（防 UI 欺骗 / 外发跟踪 / HTML 逃逸，详见 user-css.ts 头注释）
//   - 链接强制走 https 转换 + rel="noopener noreferrer"
//   - 强制 external 链接 target="_blank"
//   - 内部 [[Wiki Link]] 单独处理（这里只接渲染，将来 Sprint 3 加）

import { marked, type Token } from "marked";
import DOMPurify from "dompurify";
import { preprocessAll, parseFrontmatter, findCalloutTransforms } from "./obsidian";
import { extractLatex, restoreLatex, type LatexExtraction } from "./latex";
import { classifyHref, assignHeadingIds, type ParsedLink } from "./link-handler";
import { filterInlineStyle, extractStyleBlocks, buildUserStyleTag } from "./user-css";
import { renderMermaid, type MermaidResult, type MermaidTheme } from "./mermaid";

export interface PreviewOptions {
    /** 预留：自定义 marked 配置钩子 */
}

/** 滚动到目标块时，其顶部与容器顶部的留白（px），避免标题紧贴容器上沿 */
const PREVIEW_TOP_PADDING = 8;

export interface RenderOptions {
    /**
     * 为每个顶层块注入 data-line 属性（块对应的源 markdown 行号，1-based，
     * 含 frontmatter）。编辑器侧行号与预览行号因此对齐；同步滚动也以该
     * 属性为锚点。默认关闭以保持纯渲染输出（兼容既有测试/调用方）。
     */
    lineNumbers?: boolean;
}

// 简化的 marked 配置：GFM 开启，breaks 关闭（保留段落换行语义）。
marked.setOptions({ gfm: true, breaks: false });

/** 统计换行符个数（CRLF 计 1 行界） */
function countNewlines(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
}

/** offset（0-based）所在行号（1-based） */
function lineAtOffset(s: string, offset: number): number {
    let line = 1;
    const end = Math.min(offset, s.length);
    for (let i = 0; i < end; i++) if (s.charCodeAt(i) === 10) line++;
    return line;
}

/**
 * 预处理文本行号 → 原文行号 的映射表。
 *
 * preprocessAll 对文本做了两类会改变行号的变换：
 *   1. frontmatter 剥离（行号整体前移 fmOffset）；
 *   2. callout 块替换为 HTML（替换串行数与源块不同，影响其后块的行号）。
 * wiki-link / LaTeX 占位均为行内替换，不改行结构。
 *
 * 本映射逐 callout 累积行数差，把预处理文本中的行号精确换算回原文行号。
 */
class LineMap {
    private fmOffset = 0;
    private spans: Array<{ prepStart: number; prepLines: number; origStart: number; delta: number }> = [];

    constructor(md: string, preprocessed: string) {
        const { frontmatter, body } = parseFrontmatter(md);
        if (frontmatter) {
            this.fmOffset = countNewlines(md.slice(0, md.length - body.length));
        }
        let prepCursor = 0;
        for (const t of findCalloutTransforms(body)) {
            const pIdx = preprocessed.indexOf(t.replacement, prepCursor);
            if (pIdx < 0) continue; // 理论不可达：替换串必在预处理输出中
            const prepStart = lineAtOffset(preprocessed, pIdx);
            const prepLines = countNewlines(t.replacement) + 1;
            this.spans.push({
                prepStart,
                prepLines,
                origStart: t.startLine + this.fmOffset,
                delta: t.rawLines - prepLines,
            });
            prepCursor = pIdx + t.replacement.length;
        }
    }

    /** 预处理文本行号（1-based）→ 原文行号（1-based，含 frontmatter） */
    toOriginal(prepLine: number): number {
        let shift = 0;
        for (const s of this.spans) {
            if (prepLine < s.prepStart) return prepLine + shift + this.fmOffset;
            if (prepLine < s.prepStart + s.prepLines) return s.origStart; // callout 块内 → 源块起始行
            shift += s.delta;
        }
        return prepLine + shift + this.fmOffset;
    }
}

/** 在 HTML 片段的首个开标签上注入 data-line 属性 */
function annotateLine(html: string, line: number): string {
    if (!line) return html;
    return html.replace(/<([a-zA-Z][a-zA-Z0-9]*)(?=[\s>])/, `<$1 data-line="${line}"`);
}

/** 剥离用户内容自带的 data-line 属性（锚点行号只信程序计算值，防注入污染同步滚动） */
function stripDataLine(html: string): string {
    return html.replace(/\sdata-line\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, "");
}

/**
 * 把 Markdown 文本渲染成安全的 HTML。
 * 流程：公式提取 → obsidian 预处理 → marked → DOMPurify（严格模式）
 *       → link DOM 加固 → 公式还原
 *
 * 公式的两步拆分是有意为之：
 *   - 提取必须在 marked **之前**，否则 `a_i * b_j` 会被当成斜体语法破坏；
 *   - 还原必须在 DOMPurify **之后**，否则 KaTeX 依赖的 style 属性与 MathML
 *     标签会被清洗掉。KaTeX 以 trust:false 运行，输出无 XSS 面，
 *     因此放在最后一步注入是安全的（详见 latex.ts 头注释）。
 *
 * 注意：renderMarkdown 返回字符串供测试；link 加固在返回前通过 DOMParser
 * 解析后遍历 <a> 节点强制加 rel/target，避免正则边界场景失败。
 *
 * opts.lineNumbers 开启时改为逐顶层 token 渲染：marked.lexer 保证顶层 token
 * 的 raw 串拼接等于输入文本，用累积 offset 即可得到每个块的起始行；块间
 * 空行（space token）不产出 HTML、自动跳过。再经 LineMap 换算回原文行号。
 */
export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
    if (!md) return "";
    // 整文渲染 LRU（审查 🟡-7）：切 tab 往返 / 内容未变时直接复用上次结果，
    // 跳过 marked + DOMPurify + KaTeX 全管线。上限 8 条防无界增长。
    //
    // 审查 G2（v0.2.11）：key 不再用整篇 md 原文。原文长度可达 MaxReadSize
    // （50MB），8 条缓存光 key 就要 ~800MB 常驻。改用长度 + 内容摘要，
    // key 开销从 O(文档大小) 降为 O(1)；value（HTML）本来就必须留着。
    const key = `${opts.lineNumbers ? "L" : "P"}\u0000${md.length}\u0000${contentDigest(md)}`;
    const hit = renderCache.get(key);
    if (hit !== undefined) {
        renderCache.delete(key); // LRU touch
        renderCache.set(key, hit);
        return hit;
    }
    const out = renderMarkdownUncached(md, opts);
    if (renderCache.size >= RENDER_CACHE_MAX) {
        const oldest = renderCache.keys().next().value;
        if (oldest !== undefined) renderCache.delete(oldest);
    }
    renderCache.set(key, out);
    return out;
}

const RENDER_CACHE_MAX = 8;
const renderCache = new Map<string, string>();

/**
 * 文档内容摘要，仅用于缓存 key（审查 G2）。
 *
 * 两个不同 offset basis / 质数的 FNV-1a 变体拼成 ~64 位摘要：单条 32 位
 * 哈希在长期运行的编辑器里仍有可感知的碰撞概率，而**碰撞的后果是渲染出
 * 另一篇文档的内容**——属于必须避免的严重错误，因此用双哈希把概率压到
 * 天文数字级（2^-64），再加长度做第三重区分。
 *
 * 逐 code unit 处理（不拆代理对）即可：摘要只要求"同内容同值、异内容异值"，
 * 不需要字符语义。
 */
function contentDigest(s: string): string {
    let h1 = 0x811c9dc5; // FNV offset basis
    let h2 = 0x01000193; // 第二个独立初值
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 0x01000193); // FNV prime
        h2 ^= c;
        h2 = Math.imul(h2, 0x85ebca6b); // 不同质数，与 h1 独立
    }
    return `${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

// 审查 P1-3：顶层块缓存（key = token.raw → value = 全管线处理后的
// { html, css }）。仅 lineNumbers 路径使用；LRU 上限按块数（单块通常
// 数百字节，512 块 ≈ 数百 KB 内存，可接受）。命中块跳过
// marked.parser + DOMPurify + DOMParser 全部开销（实测这三段才是
// 渲染耗时大头，jsdom 下 78KB 文档分别占 ~20ms / ~200ms / ~74ms）。
interface CachedBlock {
    /** 全管线（parser→checkbox 占位→style 摘除→sanitize→link 加固→还原）后的块 HTML，不含 data-line */
    html: string;
    /** 该块内摘出的用户 <style> 规则（文档级拼装 userCss 用） */
    css: string;
}
// 容量按「整篇大文档的全部块」设计（200KB 文档 ≈ 2000-4000 块）：
// 若容量小于块数，LRU 在顺序扫描下会全量 thrash（每块刚插入就被逐出），
// 增量渲染零收益。4096 块 × 平均数百字节 ≈ 数 MB 字符串，桌面应用可接受。
const BLOCK_CACHE_MAX = 4096;
const blockCache = new Map<string, CachedBlock>();

function renderMarkdownUncached(md: string, opts: RenderOptions): string {
    // 公式先抽成占位符（同时豁免代码块/行内代码/转义的 \$）
    const { text: afterLatex, ext, re } = extractLatex(md);
    // Sprint 3: Obsidian 语法预处理（双链 / Callout / 资产）
    const preprocessed = preprocessAll(afterLatex);

    if (opts.lineNumbers) {
        // 审查 P1-3：lineNumbers 路径按顶层 token 分块渲染并缓存。
        // 大文档每敲一个键改动的通常只是一个块，其余块 raw 未变 →
        // 命中缓存直接复用全管线结果（parser + DOMPurify + DOMParser
        // 全部跳过），实测增量渲染从 ~340ms 降到 ~40ms（78KB, jsdom）。
        //
        // 等价性说明（分块 vs 整文执行同一管线）：
        //   - taskCheckboxPlaceholder / extractStyleBlocks / restoreCheckboxes
        //     / restoreLatex 均为逐段正则替换，分块拼接与整文结果一致；
        //   - DOMPurify 按片段清洗与整文清洗对同一片段输出一致（实测
        //     逐字节相同），模块级 style/data:URI hook 对两者同样生效；
        //   - hardenLinks 的 DOMParser 遍历是片段无关的逐 <a> 操作；
        //   - 行号（annotateLine）与用户 CSS 拼装留在文档级、每次现算，
        //     不进缓存 —— 行号随块位置变化，CSS 需要收集全部块。
        //
        // latex 占位符为会话级盐（见 latex.ts），同一文本跨渲染的
        // token.raw 稳定，含公式文档也能命中；公式序号随文档前部增删
        // 漂移时 raw 随之变化，只会退化为重渲，不会还原错内容。
        const map = new LineMap(afterLatex, preprocessed);
        const tokens = marked.lexer(preprocessed);
        let offset = 0; // 已消费的字符数（token.raw 拼接 = preprocessed）
        let out = "";
        const cssParts: string[] = [];
        for (const tk of tokens) {
            const raw = tk.raw ?? "";
            const line = raw.trim() ? map.toOriginal(lineAtOffset(preprocessed, offset)) : 0;
            offset += raw.length;
            if (!raw.trim()) continue; // 块间空行不产 HTML
            let block = blockCache.get(raw);
            if (block === undefined) {
                block = renderBlockPipeline(tk, ext, re);
                if (blockCache.size >= BLOCK_CACHE_MAX) {
                    const oldest = blockCache.keys().next().value;
                    if (oldest !== undefined) blockCache.delete(oldest);
                }
                blockCache.set(raw, block);
            } else {
                blockCache.delete(raw); // LRU touch
                blockCache.set(raw, block);
            }
            cssParts.push(block.css);
            out += annotateLine(block.html, line);
        }
        return out + buildUserStyleTag(cssParts.filter((c) => c).join("\n"));
    }

    // 非 lineNumbers 路径：整文管线（纯渲染输出，供测试与调用方）
    let rawHtml = marked.parse(preprocessed, { async: false }) as string;
    // 任务列表复选框先行占位（sanitize 前处理，见 taskCheckboxPlaceholder 注释）
    rawHtml = taskCheckboxPlaceholder(rawHtml);
    // v0.2.7 内嵌 CSS：<style> 块在 DOMPurify 之前摘除（否则被 FORBID_TAGS 整块
    // 剥掉），经 scopeUserCss 重写为 .preview-content 作用域 CSS 后由渲染管线
    // 以 <style data-user-css> 拼回输出末尾。重写器输出不含原始用户 HTML，
    // 且对 </style> 逃逸做了转义（见 user-css.ts 头注释的威胁模型）。
    const { html: htmlNoStyle, css: userCss } = extractStyleBlocks(rawHtml);
    // 末尾拼接作用域化的用户 <style> 块（无有效规则时为空串）
    return finalizeHtml(htmlNoStyle, ext, re) + buildUserStyleTag(userCss);
}

/**
 * 单个顶层 token 走完整安全管线，产出可缓存的块结果。
 * 步骤与整文管线严格同序：parser → 剥用户 data-line →
 * checkbox 占位 → <style> 摘除 → DOMPurify → link 加固 → checkbox 还原
 * → 公式还原。
 */
function renderBlockPipeline(tk: Token, ext: LatexExtraction, re: RegExp): CachedBlock {
    let piece = stripDataLine(marked.parser([tk]) as string);
    piece = taskCheckboxPlaceholder(piece);
    const { html: htmlNoStyle, css } = extractStyleBlocks(piece);
    return { html: finalizeHtml(htmlNoStyle, ext, re), css };
}

/** 整文/单块共用的后段管线：DOMPurify → link 加固 → checkbox 还原 → 公式还原 */
function finalizeHtml(htmlNoStyle: string, ext: LatexExtraction, re: RegExp): string {
    // 第一道：DOMPurify 严格清洗。
    // 注意：input 已在 sanitize 之前被 taskCheckboxPlaceholder 替换为 span 占位——
    // DOMPurify 的 ALLOWED_URI_REGEXP 会把 jsdom 下 input[type] 误判为 URI 属性剥掉
    //（浏览器与 jsdom 对 URI 属性的判定不一致），占位符方案对两套环境行为一致。
    const clean = DOMPurify.sanitize(htmlNoStyle, SANITIZE_OPTIONS);

    // 第二道：link 节点 DOM 加固（F10 修复：正则 → DOM 操作，覆盖单引号/跨行/属性含 > 边界）
    let hardened = hardenLinks(clean);
    // 第二道半：任务列表复选框占位符还原为安全的 disabled checkbox
    hardened = restoreCheckboxes(hardened);
    // 第三道：还原公式（KaTeX 输出需在 DOMPurify 之后注入）与代码块原文
    return restoreLatex(hardened, ext, re);
}

// v0.2.7 白名单（内嵌 HTML 渲染）：
//   - 语义/排版标签：figure figcaption details summary mark abbr q cite
//     small dl dt dd caption col colgroup address time var samp bdi bdo wbr
//   - 媒体标签：video audio source track picture（autoplay 不放行，防骚扰）
//   - style 属性放行但经 DOMPurify hook 声明级过滤（filterInlineStyle）
//   - data:image base64 放行（明确排除 svg+xml —— SVG 可携带脚本向量）
const SANITIZE_OPTIONS = {
    ALLOWED_TAGS: [
        "a", "p", "div", "span", "em", "strong", "b", "i", "u", "s", "code", "pre",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "ul", "ol", "li",
        "blockquote", "hr", "br",
        "img", "table", "thead", "tbody", "tr", "th", "td",
        "kbd", "del", "ins", "sup", "sub",
        // v0.2.7 内嵌 HTML 扩充
        "figure", "figcaption", "details", "summary", "mark", "abbr",
        "q", "cite", "small", "dl", "dt", "dd", "caption", "col", "colgroup",
        "address", "time", "var", "samp", "bdi", "bdo", "wbr",
        "video", "audio", "source", "track", "picture",
    ],
    ALLOWED_ATTR: [
        "href", "title", "src", "alt", "class", "target", "rel", "id", "loading", "data-wikilink", "data-line",
        // v0.2.7 内嵌 HTML/CSS 扩充
        "style",
        "controls", "loop", "muted", "preload", "poster", "type",
        "width", "height", "colspan", "rowspan", "span", "scope",
        "datetime", "start", "reversed", "open", "dir",
        "kind", "srclang", "label",
    ],
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input", "button", "link", "script", "meta", "base"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onmouseout", "onfocus", "onblur", "srcdoc"],
    // v0.2.11（审查 R1）：放行形态按"白名单协议 + 本地路径"两段判定。
    //
    // 历史：v0.2.x 曾把相对路径全剥（href=null，链接不可点），当时补了
    // `./`、`../` 与 `[a-zA-Z0-9._-]` 开头三条分支。但最后一条只认 ASCII 开头，
    // 中文文件名（marked 会百分号编码成 %E6%96%87…，% 不在首字符类里）和
    // Windows 盘符（`C:/notes/a.md`，冒号前被当成 scheme）仍被剥 —— 这是本次修的复发。
    //
    // 现在第 5 条改为"任意非 scheme 的本地路径"：用负向前瞻排除
    // `scheme:` 形态（javascript:/vbscript:/file:/blob:/data: 等一律拒绝），
    // 其余（中文、% 编码、空格外的任意字符）放行；盘符单独作为第 4 条前置，
    // 否则 `C:` 会被 scheme 前瞻误杀。
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|gif|jpeg|jpg|webp|avif|bmp|x-icon);base64,|\/|#|[a-zA-Z]:[\\/]|(?![a-zA-Z][a-zA-Z0-9+.-]*:)[^\s<>"'`]*)/i,
};

// v0.2.7：style 属性过滤 hook（模块级注册一次，全项目唯一的 DOMPurify 实例
// 就在本文件，不影响其他调用方）。属性值经声明级黑名单过滤：
// position:fixed / z-index / 外发 url() 等攻击面见 user-css.ts 头注释。
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = (data.attrName || "").toLowerCase();
    if (name === "style") {
        data.attrValue = filterInlineStyle(data.attrValue || "");
        return;
    }
    // data: URI 收窄：DOMPurify 内置兜底对 img/video/audio 等媒体标签放行
    // 全部 data:/blob: URI，这里收紧为图片 base64 白名单 MIME（明确排除
    // 可携带脚本向量的 svg+xml 与 text/html）
    if (name === "src" && /^data:/i.test(data.attrValue || "")) {
        if (!/^data:image\/(?:png|gif|jpeg|jpg|webp|avif|bmp|x-icon);base64,/i.test(data.attrValue)) {
            data.keepAttr = false;
        }
    }
});

/**
 * GFM 任务列表复选框的两步处理：
 *
 * 1) sanitize 前（taskCheckboxPlaceholder）：把 marked 输出的
 *    `<input type=checkbox checked disabled>` 替换为
 *    `<span class="${CHECKBOX_PLACEHOLDER_CLASS}" data-checked="1"></span>` 占位。
 *    - 绕开 DOMPurify 对 input 的属性歧义（jsdom 会把 input[type] 当 URI 属性校验并剥除）
 *    - 任何用户裸 HTML 注入的 input（非 checkbox+disabled 形态）不匹配替换正则，
 *      直接被 FORBID_TAGS 剥掉，天然免疫注入
 * 2) sanitize 后（restoreCheckboxes）：占位 span 还原为
 *    `<input type="checkbox" checked disabled>`——属性是程序白名单生成的，
 *    无任何用户可控内容，disabled 保证无交互面。
 */
//
// 审查 G4（v0.2.11）：占位 class 改为**带随机盐**的形态。
//
// 原先是可预测的固定串 `litemd-cb`，用户裸 HTML 写
// `<span class="litemd-cb"></span>` 就会被还原阶段当成占位符替换成复选框
// （data-checked 会被 DOMPurify 剥掉，所以 checked 状态仍不可控，无安全影响，
// 但渲染结果与书写意图不符）。加盐后 class 名不可预测，与 KaTeX 占位符
// （latex.ts）的防伪思路一致；用户伪造的 span 会原样保留为空 span。
const CHECKBOX_PLACEHOLDER_CLASS = `litemd-cb-${Math.random().toString(36).slice(2, 10)}`;

function taskCheckboxPlaceholder(html: string): string {
    // 属性顺序无关：marked 实际输出为 <input disabled="" type="checkbox">
    //（disabled 在 type 前），不能假设固定顺序
    return html.replace(
        /<input\b[^>]*>/g,
        (tag: string) => {
            const isCheckbox = /type="checkbox"/.test(tag);
            const isDisabled = /\bdisabled/.test(tag);
            if (!isCheckbox || !isDisabled) return tag; // 非法形态留给 FORBID_TAGS 剥除
            const checked = /\bchecked/.test(tag) ? ' data-checked="1"' : "";
            return `<span class="${CHECKBOX_PLACEHOLDER_CLASS}"${checked}></span>`;
        },
    );
}

// 还原正则按占位 class 预编译一次（P1-3：分块渲染下本函数高频调用，
// 不能每次 replace 都现场 new RegExp）。
const CHECKBOX_RESTORE_RE = new RegExp(
    `<span\\s+class="${CHECKBOX_PLACEHOLDER_CLASS}"(?:\\s+data-checked="1")?\\s*\\/?>(?:\\s*</span>)?`,
    "g",
);

/** 占位 span → disabled checkbox（sanitize 后调用，输入已无用户可控属性） */
function restoreCheckboxes(html: string): string {
    return html.replace(
        CHECKBOX_RESTORE_RE,
        (m) => (m.includes("data-checked") ? '<input type="checkbox" checked disabled>' : '<input type="checkbox" disabled>'),
    );
}

/**
 * 用 DOMParser 解析 HTML，遍历所有 <a> 节点强制加 target="_blank" rel="noopener noreferrer"。
 * 仅对 http(s) 外链生效，内部锚点（#/wiki/...）不受影响。
 *
 * 审查 P1-3 适配（分块渲染下本函数被高频调用）：
 *   - 共享单个 DOMParser 实例（无状态可复用；jsdom 下每次 new 会随调用
 *     次数二次劣化，实测 2000 次从 640ms 涨到 5700ms）；
 *   - 输入是 **sanitize 之后**的 HTML，字面 < 已转义为 &lt;，因此串中
 *     出现 `<a` 只可能是真实锚标签 —— 无 `<a` 直接跳过 DOM 解析。
 */
const sharedDomParser: DOMParser | null = typeof DOMParser !== "undefined" ? new DOMParser() : null;

function hardenLinks(html: string): string {
    if (!/<a[\s>]/i.test(html) || !sharedDomParser) return html;
    const doc = sharedDomParser.parseFromString(`<body>${html}</body>`, "text/html");
    doc.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href") || "";
        // 仅外部 http(s) 链接加固
        if (/^https?:\/\//i.test(href)) {
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener noreferrer");
        }
    });
    return doc.body?.innerHTML ?? html;
}

/**
 * 应用到 DOM 节点上：先清空，再写入 sanitize 后的 HTML。
 * 这是预览面板的入口。
 */
/** 渲染选项：相对资源解析所需的上文 */
export interface PreviewRenderOptions {
    /**
     * 当前文档的绝对路径。相对链接与相对图片都以它所在目录为基准解析；
     * 未保存的新文档传空串（此时相对链接无法解析，前端会引导先保存）。
     */
    basePath?: string;
    /**
     * 把本地相对图片解析成 data URL（由主应用组合 Go 的
     * ResolveLocalPath + ReadLocalAsset 实现）。返回 null 表示解析失败。
     */
    resolveAsset?: (src: string) => Promise<string | null>;
}

export class Preview {
    private clickHandler: ((target: string, ev: MouseEvent) => void) | null = null;
    private linkHandler: ((link: ParsedLink, ev: MouseEvent) => void) | null = null;
    /** 渲染代号：异步资源回填时用于丢弃过期结果（切 tab / 快速输入） */
    private renderGen = 0;
    /**
     * 渲染内容包裹层（v0.2.7）：host(.preview) > wrap(.preview-content)。
     * 用户内嵌 CSS 的选择器被 scopeUserCss 前缀化为 .preview-content ——
     * 包裹层保证用户 CSS 最远只能影响预览区内部，无法命中 .preview 之外
     * 的应用 UI（编辑器 / 侧栏 / 标题栏）。滚动容器仍是 host，滚动 API
     * 不受影响。
     */
    private wrap: HTMLElement;

    constructor(private host: HTMLElement) {
        this.wrap = document.createElement("div");
        this.wrap.className = "preview-content";
        this.host.appendChild(this.wrap);
        // 事件委托：捕获点击，识别 .wiki-link
        this.host.addEventListener("click", (ev) => {
            const target = ev.target as HTMLElement;
            if (!target) return;
            const link = target.closest(".wiki-link") as HTMLAnchorElement | null;
            if (!link) return;
            ev.preventDefault();
            const w = link.dataset.wikilink || "";
            if (this.clickHandler) this.clickHandler(w, ev);
        });
        // 事件委托：拦截**所有**链接的默认导航行为。
        //
        // 这是 v0.2.6 的核心修复：此前只有 .wiki-link 被拦截，普通的
        // [文本](../a.md) 会让 WebView2 就地导航到 http://wails.localhost/a.md
        // → assetserver 404 → 前端 SPA 被卸载（界面消失、未保存内容丢失）。
        //
        // 注册顺序在 wiki-link 监听**之后**：wiki-link 已 preventDefault 时
        // defaultPrevented 为真，这里直接放行，原双链行为完全不变。
        // auxclick 覆盖中键点击，click 覆盖左键 / Ctrl+点击 / Shift+点击。
        const swallowNavigation = (ev: MouseEvent) => {
            if (ev.defaultPrevented) return;
            const a = (ev.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
            if (!a || !this.host.contains(a)) return;
            // 一律阻止默认导航：后续动作由主应用决定（应用内打开 / 系统程序 / 提示）
            ev.preventDefault();
            const parsed = classifyHref(a.getAttribute("href") || "");
            if (this.linkHandler) this.linkHandler(parsed, ev);
        };
        this.host.addEventListener("click", swallowNavigation);
        this.host.addEventListener("auxclick", swallowNavigation);

        // 事件委托：代码块复制按钮。
        // 必须绑在 constructor（host 从不被 innerHTML 清空，一次绑定终身有效）——
        // 旧版绑在 render() 内，每次渲染都追加一个监听器只增不减，长编辑会话
        // 点击一次复制会执行成百上千次 clipboard 写入（R1 修复）。
        this.host.addEventListener("click", (ev) => {
            const btn = (ev.target as HTMLElement)?.closest<HTMLButtonElement>(".code-block-copy");
            if (!btn) return;
            const code = btn.closest(".code-block")?.querySelector("pre code");
            if (!code) return;
            const text = code.textContent || "";
            // clipboard 在非安全上下文可能为 undefined：可选链会静默吞掉这次点击，
            // 显式降级提示而非无反馈（审查 🟢-4）
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(
                    () => flashCopyState(btn, "已复制"),
                    () => flashCopyState(btn, "复制失败"),
                );
            } else {
                flashCopyState(btn, "剪贴板不可用");
            }
        });
    }

    /** 注册 wiki-link 点击回调（主应用实现：切换到对应 tab，或打开） */
    onWikiLinkClick(handler: (target: string, ev: MouseEvent) => void) {
        this.clickHandler = handler;
    }

    /** 注册普通链接点击回调（主应用实现：应用内打开 / 系统程序 / 提示 / 锚点滚动） */
    onLinkClick(handler: (link: ParsedLink, ev: MouseEvent) => void) {
        this.linkHandler = handler;
    }

    render(md: string, opts: PreviewRenderOptions = {}) {
        // lineNumbers: 预览面板始终启用行号标注（与编辑器行号对齐 + 同步滚动锚点）
        const html = renderMarkdown(md, { lineNumbers: true });
        const gen = ++this.renderGen;
        // 写入包裹层而非 host：用户 CSS 作用域被限制在 .preview-content 内
        this.wrap.innerHTML = html;
        // 兜底：再一次剥离去除残留事件属性
        this.scrub(this.wrap);
        // v0.2.8 mermaid 代码块：在 decorate 之前替换为 .mermaid-block 容器，
        // 让 decorate 的「pre > code[class*='language-']」选择器不再命中（mermaid
        // 图表不是代码，不出现复制按钮），原码存到 dataset.code 用于异步水合
        this.replaceMermaidBlocks();
        // 代码块装饰：注入语言标签 + 复制按钮（Obsidian 风）
        this.decorateCodeBlocks(this.wrap);
        // 标题锚点：marked v5+ 不再生成 id，不补 id 则 [x](#标题) 点了不会滚动
        this.annotateHeadingIds();
        // 图片懒加载（审查 🟢-10）：marked 不输出 loading 属性，DOM 阶段
        // 统一补上，长文档含多图时显著减少首屏网络/解码开销
        this.wrap.querySelectorAll("img").forEach((img) => {
            if (!img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
        });
        // 相对路径图片：请求 wails.localhost 下不存在的 HTTP 路径必然破图，
        // 交由主应用解析为磁盘文件（data URL）后回填
        if (opts.resolveAsset) void this.resolveLocalImages(opts.resolveAsset, gen);
        // mermaid：动态 import + 图级缓存 + 异步水合（启动≈0，hit 0ms）
        void this.hydrateMermaidBlocks(this.wrap.querySelectorAll<HTMLElement>(".mermaid-block"), gen);
    }

    /**
     * 为所有标题补 id（GitHub 风格 slug，重复时自动加序号后缀）。
     *
     * 只设置缺失的 id：marked 未来若恢复 headerIds，不覆盖其既有结果。
     */
    private annotateHeadingIds(): void {
        const headings = Array.from(this.wrap.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
        if (!headings.length) return;
        const ids = assignHeadingIds(headings.map((h) => h.textContent || ""));
        headings.forEach((h, i) => {
            if (!h.id) h.id = ids[i];
        });
    }

    /**
     * 把相对路径图片替换成本地文件的 data URL。
     *
     * 竞态处理：解析是异步的，期间用户可能切 tab 或继续输入——用 renderGen
     * 判断结果是否仍然对应当前渲染，过期结果直接丢弃（否则会把上一份文档的
     * 图片贴到新内容上）。
     */
    private async resolveLocalImages(
        resolve: (src: string) => Promise<string | null>,
        gen: number,
    ): Promise<void> {
        const imgs = Array.from(this.wrap.querySelectorAll<HTMLImageElement>("img[src]"));
        const pending = imgs.filter((img) => {
            const src = img.getAttribute("src") || "";
            // 外链 / data URL / 空 src 不需要本地解析
            return src !== "" && !/^(?:https?:|data:|blob:)/i.test(src);
        });
        if (!pending.length) return;
        pending.forEach((img) => { img.dataset.assetPending = "1"; });

        await Promise.all(pending.map(async (img) => {
            const src = img.getAttribute("src") || "";
            const dataUrl = await resolve(src).catch(() => null);
            delete img.dataset.assetPending;
            // 过期结果或元素已被新一次渲染替换：丢弃
            if (gen !== this.renderGen || !img.isConnected) return;
            if (dataUrl) {
                img.src = dataUrl;
            } else {
                img.dataset.assetBroken = "1";
                img.title = `本地图片未找到：${src}`;
            }
        }));
    }

    /**
     * 滚动预览区到指定锚点（标题 id）。找到并滚动返回 true，否则 false。
     *
     * 锚点链接是 hash，本身不会卸载页面，但不处理就是"点了没反应"。
     */
    scrollToAnchor(anchor: string): boolean {
        if (!anchor) return false;
        const decoded = safeDecode(anchor);
        const el =
            this.wrap.querySelector<HTMLElement>(`#${cssEscape(decoded)}`) ??
            this.wrap.querySelector<HTMLElement>(`#${cssEscape(anchor)}`);
        if (!el) return false;
        const hostTop = this.host.getBoundingClientRect().top;
        const elTop = el.getBoundingClientRect().top;
        this.host.scrollTop += elTop - hostTop - PREVIEW_TOP_PADDING;
        return true;
    }

    clear() {
        this.wrap.innerHTML = "";
    }

    /**
     * 滚动预览区，让指定源码行对应的内容块对齐容器顶部。
     *
     * 复用 render() 注入的 data-line 属性（见 renderMarkdown 的 lineNumbers 分支），
     * 因此预览侧不需要再单独维护一套标题索引 —— 两套索引最容易失步。
     *
     * 找不到精确等于 line 的块时，退到"最后一个 line 之前的块"：标题若被包在
     * 列表/callout 等容器里，其块行号会等于容器起始行而非标题本身所在行。
     */
    scrollToLine(line: number): void {
        const blocks = this.blocksWithLine();
        if (!blocks.length) return;
        let target = blocks[0];
        for (const b of blocks) {
            if (b.line <= line) target = b;
            else break;
        }
        const hostTop = this.host.getBoundingClientRect().top;
        const elTop = target.el.getBoundingClientRect().top;
        this.host.scrollTop += elTop - hostTop - PREVIEW_TOP_PADDING;
    }

    /**
     * 视口顶部当前所处的标题行号；位于首個标题之前时返回 0。
     * 供"仅预览"模式下驱动大纲高亮（该模式下编辑器不可见，无光标可用）。
     */
    activeHeadingLine(): number {
        const hostTop = this.host.getBoundingClientRect().top;
        let line = 0;
        for (const h of this.headings()) {
            // 容差取 24px：预览有 16px 上内边距，滚到最顶时首个标题仍应算"已到达"
            if (h.el.getBoundingClientRect().top - hostTop <= 24) line = h.line;
            else break;
        }
        return line;
    }

    /** 带原文行号的顶层块（文档顺序） */
    private blocksWithLine(): Array<{ el: HTMLElement; line: number }> {
        const out: Array<{ el: HTMLElement; line: number }> = [];
        this.wrap.querySelectorAll<HTMLElement>("[data-line]").forEach((el) => {
            const line = Number(el.dataset.line);
            if (Number.isFinite(line) && line > 0) out.push({ el, line });
        });
        return out;
    }

    /** 其中的标题块（h1–h6） */
    private headings(): Array<{ el: HTMLElement; line: number }> {
        return this.blocksWithLine().filter((b) => /^H[1-6]$/.test(b.el.tagName));
    }

    /**
     * 兜底 XSS 清理：即便 DOMPurify 被 bypass，强制不再含 <script>/javascript:
     */
    private scrub(root: HTMLElement) {
        const scripts = root.querySelectorAll("script");
        scripts.forEach((s) => s.remove());
        root.querySelectorAll("*").forEach((el) => {
            Array.from(el.attributes).forEach((attr) => {
                if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
                if ((attr.name === "href" || attr.name === "src") && /javascript:/i.test(attr.value)) {
                    el.removeAttribute(attr.name);
                }
            });
        });
    }

    /**
     * 为每个带语言的代码块包一层 .code-block 容器，并在顶部插入
     * 「语言标签 + 复制按钮」头部（Obsidian 风）。
     *
     * 不动 <pre> 上的 data-line 等已有属性，所以同步滚动、目录跳转
     * 全部继续工作（blocksWithLine 用 querySelectorAll 仍能找到嵌套的 pre）。
     */
    private decorateCodeBlocks(root: HTMLElement) {
        root.querySelectorAll<HTMLPreElement>("pre > code[class*='language-']").forEach((code) => {
            const pre = code.parentElement as HTMLPreElement | null;
            if (!pre || pre.dataset.decorated === "1") return;
            pre.dataset.decorated = "1";

            const m = (code.className.match(/language-([\w+-]+)/) || [, ""])[1];
            const lang = m || "text";

            const wrap = document.createElement("div");
            wrap.className = "code-block";

            const header = document.createElement("div");
            header.className = "code-block-header";
            const langEl = document.createElement("span");
            langEl.className = "code-block-lang";
            langEl.textContent = lang;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "code-block-copy";
            btn.setAttribute("aria-label", "复制代码");
            btn.title = "复制代码";
            btn.innerHTML = COPY_ICON;
            header.appendChild(langEl);
            header.appendChild(btn);

            // 在 pre 前插入 header，pre 移到 wrap 内
            pre.parentElement?.insertBefore(wrap, pre);
            wrap.appendChild(header);
            wrap.appendChild(pre);
        });
    }

    // ============================================================================
    // v0.2.8 mermaid：把 ```mermaid 代码块替换为图表占位容器，异步水合 SVG
    // ============================================================================

    /**
     * 把标记为 mermaid 的代码块替换为 div.mermaid-block 容器。
     * 原码保留到 dataset.code（加载中显示）+ dataset.state="loading"。
     * 必须在 decorateCodeBlocks 之前调用，否则会先被包进 .code-block 装饰。
     */
    private replaceMermaidBlocks(): void {
        const codes = this.wrap.querySelectorAll<HTMLElement>("pre > code.language-mermaid");
        codes.forEach((code) => {
            const pre = code.parentElement;
            if (!pre) return;
            const raw = (code.textContent || "").replace(/\n$/, "");
            const holder = document.createElement("div");
            holder.className = "mermaid-block";
            holder.dataset.code = raw;
            holder.dataset.state = "loading";
            holder.textContent = raw; // 加载中保留原文等宽显示，便于校对
            pre.replaceWith(holder);
        });
    }

    /**
     * 异步把一批 .mermaid-block 容器水合成 SVG 或错误占位。
     * 遍历传入的 holder 列表（render 与 onThemeChange 共用），按指定主题调
     * renderMermaid；过期结果由 gen + isConnected 守卫丢弃。
     */
    private async hydrateMermaidBlocks(
        holders: ArrayLike<HTMLElement>,
        gen: number,
        theme: MermaidTheme = currentMermaidTheme(),
    ): Promise<void> {
        const list = Array.from(holders).filter((h) => h.dataset.state === "loading");
        if (!list.length) return;
        await Promise.all(list.map(async (holder) => {
            const code = holder.dataset.code || "";
            const result = await renderMermaid(code, theme);
            // 过期结果 / 元素被新一次渲染替换：丢弃
            if (gen !== this.renderGen || !holder.isConnected) return;
            applyMermaidResult(holder, result);
        }));
    }

    /**
     * 主题切换回调：仅重新渲染已 ok 状态的 mermaid 块，不重 render 整文档。
     * 缓存按 theme 隔离，切换瞬间会有一次重渲染（图级缓存随即建立）。
     * renderGen++ 让在途请求自然过期。调用方传入新主题，避免
     * 「documentElement.dataset.theme 已变但 hydrate 时再读一次」的竞态。
     */
    onThemeChange(newTheme: MermaidTheme): void {
        const holders = Array.from(this.wrap.querySelectorAll<HTMLElement>(".mermaid-block"))
            .filter((h) => h.dataset.state === "ok" || h.dataset.state === "loading");
        if (!holders.length) return;
        const gen = ++this.renderGen;
        // 重置为 loading 态，便于水合过程观察到过渡
        holders.forEach((h) => {
            h.dataset.state = "loading";
            h.textContent = h.dataset.code || "";
        });
        void this.hydrateMermaidBlocks(holders, gen, newTheme);
    }
}

/** 当前应用主题 → mermaid 主题（与 main.ts applyTheme 同源） */
function currentMermaidTheme(): MermaidTheme {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * 把 renderMermaid 结果应用到占位容器（SVG 注入或错误降级）。
 * 按 reason 区分提示（P0-1）：引擎加载失败 ≠ 用户语法错误，不能谎报。
 */
function applyMermaidResult(holder: HTMLElement, result: MermaidResult): void {
    if (result.ok) {
        // 审计 R2-F3：mermaid 11 securityLevel:"strict" 输出已剥 on* 与
        // javascript:，但 <foreignObject> / <use href="..."> / data-* 等
        // 新型载体若未来 mermaid 默认行为回归会破防；这里再过一道
        // DOMPurify 的 SVG profile，确保即便 mermaid 失守也只能写出
        // 纯 SVG 节点。
        holder.innerHTML = DOMPurify.sanitize(result.svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
        });
        holder.dataset.state = "ok";
        return;
    }
    const code = holder.dataset.code || "";
    let msg: string;
    switch (result.reason) {
        case "load":
            msg = "Mermaid 图表引擎加载失败（依赖缺失或资源加载异常），已按原码展示。";
            break;
        case "timeout":
            msg = "Mermaid 渲染超时（图表可能过于复杂），已按原码展示。";
            break;
        case "empty":
            msg = "Mermaid 代码块为空，已按原码展示。";
            break;
        default:
            msg = "Mermaid 语法错误，已按原码展示。";
    }
    holder.textContent = `${msg}\n\n${code}`;
    holder.dataset.state = "error";
}

/** decodeURIComponent 的安全包装：非法编码串（裸 %）不会抛异常 */
function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

/** CSS.escape 的安全包装：jsdom 等环境缺失时退化为最小转义 */
function cssEscape(s: string): string {
    const esc = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
    return esc ? esc(s) : s.replace(/["\\]/g, "\\$&");
}

/** 复制成功 / 失败时按钮文案短暂切换 */
function flashCopyState(btn: HTMLButtonElement, msg: string) {
    // 原始文案固定存 dataset：旧版捕获“当前”title——1.2s 内连点两次时，
    // 第二次捕获到的是上一次的“已复制”，闪完 title 永久停留在错误文案上（审查 🟢-3）。
    if (!btn.dataset.origTitle) btn.dataset.origTitle = btn.title;
    btn.title = msg;
    btn.classList.add("is-flashed");
    setTimeout(() => {
        btn.classList.remove("is-flashed");
        btn.title = btn.dataset.origTitle || msg;
    }, 1200);
}

/** 剪贴板图标（inline SVG，无外部依赖，#7d8590 跟主题次级文字一致） */
const COPY_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
