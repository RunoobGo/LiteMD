// preview.ts — Markdown 实时预览 + XSS 防护
//
// 安全策略：
//   - DOMPurify 默认禁用危险标签：<script>, <iframe>, <object>, <embed>, on* 事件
//   - 链接强制走 https 转换 + rel="noopener noreferrer"
//   - 强制 external 链接 target="_blank"
//   - 内部 [[Wiki Link]] 单独处理（这里只接渲染，将来 Sprint 3 加）

import { marked } from "marked";
import DOMPurify from "dompurify";
import { preprocessAll, parseFrontmatter, findCalloutTransforms } from "./obsidian";
import { extractLatex, restoreLatex } from "./latex";

export interface PreviewOptions {
    /** 预留：自定义 marked 配置钩子 */
}

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
    // 公式先抽成占位符（同时豁免代码块/行内代码/转义的 \$）
    const { text: afterLatex, ext, re } = extractLatex(md);
    // Sprint 3: Obsidian 语法预处理（双链 / Callout / 资产）
    const preprocessed = preprocessAll(afterLatex);

    let rawHtml: string;
    if (opts.lineNumbers) {
        const map = new LineMap(afterLatex, preprocessed);
        const tokens = marked.lexer(preprocessed);
        let offset = 0; // 已消费的字符数（token.raw 拼接 = preprocessed）
        let out = "";
        for (const tk of tokens) {
            const raw = tk.raw ?? "";
            const line = raw.trim() ? map.toOriginal(lineAtOffset(preprocessed, offset)) : 0;
            offset += raw.length;
            if (!raw.trim()) continue; // 块间空行不产 HTML
            const piece = stripDataLine(marked.parser([tk]) as string);
            out += annotateLine(piece, line);
        }
        rawHtml = out;
    } else {
        // marked v18 同步 API：parse 返回 string（当 async: false）
        rawHtml = marked.parse(preprocessed, { async: false }) as string;
    }
    // 任务列表复选框先行占位（sanitize 前处理，见 taskCheckboxPlaceholder 注释）
    rawHtml = taskCheckboxPlaceholder(rawHtml);

    // 第一道：DOMPurify 严格清洗。
    // 注意：input 已在 sanitize 之前被 taskCheckboxPlaceholder 替换为 span 占位——
    // DOMPurify 的 ALLOWED_URI_REGEXP 会把 jsdom 下 input[type] 误判为 URI 属性剥掉
    //（浏览器与 jsdom 对 URI 属性的判定不一致），占位符方案对两套环境行为一致。
    const clean = DOMPurify.sanitize(rawHtml, {
        ALLOWED_TAGS: [
            "a", "p", "div", "span", "em", "strong", "b", "i", "u", "s", "code", "pre",
            "h1", "h2", "h3", "h4", "h5", "h6",
            "ul", "ol", "li",
            "blockquote", "hr", "br",
            "img", "table", "thead", "tbody", "tr", "th", "td",
            "kbd", "del", "ins", "sup", "sub",
        ],
        ALLOWED_ATTR: ["href", "title", "src", "alt", "class", "target", "rel", "id", "loading", "data-wikilink", "data-line"],
        FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input", "button", "link", "script"],
        FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onmouseout", "onfocus", "onblur", "style", "srcdoc"],
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|\/|#)/i,
    });

    // 第二道：link 节点 DOM 加固（F10 修复：正则 → DOM 操作，覆盖单引号/跨行/属性含 > 边界）
    let hardened = hardenLinks(clean);
    // 第二道半：任务列表复选框占位符还原为安全的 disabled checkbox
    hardened = restoreCheckboxes(hardened);
    // 第三道：还原公式（KaTeX 输出需在 DOMPurify 之后注入）与代码块原文
    return restoreLatex(hardened, ext, re);
}

/**
 * GFM 任务列表复选框的两步处理：
 *
 * 1) sanitize 前（本函数）：把 marked 输出的 `<input type=checkbox checked disabled>`
 *    替换为 `<span class="litemd-cb" data-checked="1"></span>` 占位。
 *    - 绕开 DOMPurify 对 input 的属性歧义（jsdom 会把 input[type] 当 URI 属性校验并剥除）
 *    - 任何用户裸 HTML 注入的 input（非 checkbox+disabled 形态）不匹配替换正则，
 *      直接被 FORBID_TAGS 剥掉，天然免疫注入
 * 2) sanitize 后（restoreCheckboxes）：占位 span 还原为
 *    `<input type="checkbox" checked disabled>`——属性是程序白名单生成的，
 *    无任何用户可控内容，disabled 保证无交互面。
 */
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
            return `<span class="litemd-cb"${checked}></span>`;
        },
    );
}

/** 占位 span → disabled checkbox（sanitize 后调用，输入已无用户可控属性） */
function restoreCheckboxes(html: string): string {
    return html.replace(
        /<span\s+class="litemd-cb"(?:\s+data-checked="1")?\s*\/?>(?:\s*<\/span>)?/g,
        (m) => (m.includes("data-checked") ? '<input type="checkbox" checked disabled>' : '<input type="checkbox" disabled>'),
    );
}

/**
 * 用 DOMParser 解析 HTML，遍历所有 <a> 节点强制加 target="_blank" rel="noopener noreferrer"。
 * 仅对 http(s) 外链生效，内部锚点（#/wiki/...）不受影响。
 */
function hardenLinks(html: string): string {
    // 浏览器环境用 DOMParser；node 测试环境用 jsdom 提供的 DOMParser
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<body>${html}</body>`, "text/html");
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
export class Preview {
    private clickHandler: ((target: string, ev: MouseEvent) => void) | null = null;

    constructor(private host: HTMLElement) {
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
    }

    /** 注册 wiki-link 点击回调（主应用实现：切换到对应 tab，或打开） */
    onWikiLinkClick(handler: (target: string, ev: MouseEvent) => void) {
        this.clickHandler = handler;
    }

    render(md: string) {
        // lineNumbers: 预览面板始终启用行号标注（与编辑器行号对齐 + 同步滚动锚点）
        const html = renderMarkdown(md, { lineNumbers: true });
        this.host.innerHTML = html;
        // 兜底：再一次剥离去除残留事件属性
        this.scrub(this.host);
    }

    clear() {
        this.host.innerHTML = "";
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
}
