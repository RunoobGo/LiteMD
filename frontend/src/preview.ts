// preview.ts — Markdown 实时预览 + XSS 防护
//
// 安全策略：
//   - DOMPurify 默认禁用危险标签：<script>, <iframe>, <object>, <embed>, on* 事件
//   - 链接强制走 https 转换 + rel="noopener noreferrer"
//   - 强制 external 链接 target="_blank"
//   - 内部 [[Wiki Link]] 单独处理（这里只接渲染，将来 Sprint 3 加）

import { marked } from "marked";
import DOMPurify from "dompurify";
import { preprocessAll } from "./obsidian";
import { extractLatex, restoreLatex } from "./latex";

export interface PreviewOptions {
    /** 预留：自定义 marked 配置钩子 */
}

// 简化的 marked 配置：GFM 开启，breaks 关闭（保留段落换行语义）。
marked.setOptions({ gfm: true, breaks: false });

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
 */
export function renderMarkdown(md: string): string {
    if (!md) return "";
    // 公式先抽成占位符（同时豁免代码块/行内代码/转义的 \$）
    const { text: afterLatex, ext, re } = extractLatex(md);
    // Sprint 3: Obsidian 语法预处理（双链 / Callout / 资产）
    const preprocessed = preprocessAll(afterLatex);
    // marked v18 同步 API：parse 返回 string（当 async: false）
    const rawHtml = marked.parse(preprocessed, { async: false }) as string;

    // 第一道：DOMPurify 严格清洗
    const clean = DOMPurify.sanitize(rawHtml, {
        ALLOWED_TAGS: [
            "a", "p", "div", "span", "em", "strong", "b", "i", "u", "s", "code", "pre",
            "h1", "h2", "h3", "h4", "h5", "h6",
            "ul", "ol", "li",
            "blockquote", "hr", "br",
            "img", "table", "thead", "tbody", "tr", "th", "td",
            "kbd", "del", "ins", "sup", "sub",
        ],
        ALLOWED_ATTR: ["href", "title", "src", "alt", "class", "target", "rel", "id", "loading", "data-wikilink"],
        FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input", "button", "link", "script"],
        FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onmouseout", "onfocus", "onblur", "style", "srcdoc"],
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|\/|#)/i,
    });

    // 第二道：link 节点 DOM 加固（F10 修复：正则 → DOM 操作，覆盖单引号/跨行/属性含 > 边界）
    const hardened = hardenLinks(clean);
    // 第三道：还原公式（KaTeX 输出需在 DOMPurify 之后注入）与代码块原文
    return restoreLatex(hardened, ext, re);
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
        const html = renderMarkdown(md);
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
