// obsidian.ts — Obsidian 语法兼容层
//
// 三大特性：
//   - Wiki Link [[Wiki Name]]   → 渲染为可点击锚链（点触发事件回调）
//   - Callouts    > [!note]    → 渲染为彩色 blockquote
//   - Frontmatter --- ... ---  → 解析成对象 + 折叠面板
//   - 图片拖入 → 资产复制

import { marked } from "marked";

// 与 preview.ts 保持一致的 marked 配置。
// callout 正文需在此处预渲染为 HTML：外层 renderMarkdown 会把整块 <blockquote>
// 当裸 HTML 原样保留，不会二次解析其内部 markdown，故 body 内的 **加粗** /
// `代码` / 列表 必须在预处理阶段先渲染（Obsidian 兼容保真，修复 N1）。
marked.setOptions({ gfm: true, breaks: false });

// ============================================================================
// Wiki Links
// ============================================================================

// ReDoS 加固（相对旧版 `/\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g`）：
//   1. 字符类排除 `[` —— `[` 在链接目标/别名里本就非法。这样 `[[[[[[…` 这类
//      输入在起始位置**立刻**失配，不会逐字符惰性扩展后再回溯（旧版 O(n²)）。
//   2. 用有界量词 `{1,MAX}` 取代惰性 `+?` —— 单次起始位置的回溯步数被锁死在
//      MAX 以内，最坏情况从 O(n²) 退化为 O(n·MAX)。
//      实测 8000 个 `[` 的输入：191ms → <1ms。
const WIKI_SEGMENT_MAX = 256;

const WIKI_RE = new RegExp(
    "\\[\\[" +
    `([^\\[\\]\\n|]{1,${WIKI_SEGMENT_MAX}})` +
    "(?:\\|" +
    `([^\\[\\]\\n]{1,${WIKI_SEGMENT_MAX}})` +
    ")?\\]\\]",
    "g",
);

export interface WikiLinkMatch {
    full: string;
    target: string;
    alias?: string;
    index: number;
}

/** 在文本中找出所有 [[wiki]] 引用 */
export function findWikiLinks(md: string): WikiLinkMatch[] {
    const out: WikiLinkMatch[] = [];
    // 用局部副本：共享的 /g 正则若上次 exec 中途退出会残留 lastIndex，
    // 导致下一次调用从断点续扫、漏掉前面的链接。
    const re = new RegExp(WIKI_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(md))) {
        out.push({
            full: m[0],
            target: m[1].trim(),
            alias: m[2]?.trim() || undefined,
            index: m.index,
        });
    }
    return out;
}

/** 将 [[wiki]] / [[wiki|alias]] 替换为标准 <a> 标签，premarked 形式供 marked 处理 */
export function preprocessWikiLinks(md: string): string {
    return md.replace(WIKI_RE, (_, target: string, alias: string | undefined) => {
        const rawTarget = target.trim();
        const text = (alias ?? rawTarget).trim();
        // F16 修复：href 锚点统一对"原始 target"做 encodeURIComponent，
        // 不再先过滤 chars 再编码，保证空格/中文/特殊字符编码前后一致；
        // data-wikilink 属性仍用过滤后纯文本（HTML 属性值不能含引号括号尖括号）。
        const safeText = text.replace(/[<>"']/g, "");
        const safeTargetAttr = rawTarget.replace(/[<>"']/g, "");
        return `<a class="wiki-link" data-wikilink="${safeTargetAttr}" href="#/wiki/${encodeURIComponent(rawTarget)}">${safeText}</a>`;
    });
}

// ============================================================================
// Callouts
// ============================================================================

const CALLOUT_TYPES = new Set([
    "note", "tip", "info", "warning", "danger", "example",
    "question", "success", "failure", "bug", "quote", "abstract",
]);

// CALLOUT_RE 匹配 callout 段：
//   - 必须以 > [!type] 开头
//   - 后面可以接 0+ 行 `> ...` body
//   - 段结束于第一个非 `> ` 开头的行
//
// 之前版本要求至少 1 行 body 才能匹配，导致 `> [!note] 单行` 这种合法 callout 不被识别
const CALLOUT_RE = /(^|\n)(>+\s*\[!\w+\][^\n]*(?:\n>.*)*)/g;

interface CalloutBlock {
    type: string;
    title: string;
    body: string;
}

/** 解析 > [!type] 块，返回块列表（包含类型和被消费的 body 行） */
export function findCallouts(md: string): CalloutBlock[] {
    const out: CalloutBlock[] = [];
    let m: RegExpExecArray | null;
    while ((m = CALLOUT_RE.exec(md))) {
        const block = m[2];
        // 拆分连续 blockquote 段
        const segments: string[][] = [[]];
        for (const line of block.split("\n")) {
            if (!line.startsWith(">")) {
                if (segments[segments.length - 1].length > 0) {
                    segments.push([]);
                }
                continue;
            }
            segments[segments.length - 1].push(line);
        }
        for (const seg of segments) {
            if (!seg.length) continue;
            const first = seg[0].replace(/^>\s?/, "");
            const fm = first.match(/^\[!(\w+)\]\s*([^\n]*)$/);
            if (!fm) continue;
            const type = fm[1].toLowerCase();
            if (!CALLOUT_TYPES.has(type)) continue;
            const title = fm[2].trim();
            const bodyLines = seg.slice(1).map((l) => l.replace(/^>\s?/, ""));
            out.push({ type, title, body: bodyLines.join("\n") });
        }
    }
    return out;
}

/**
 * 把 > [!type] 块变成 HTML blockquote（带 class），
 * 让 DOMPurify 保留后渲染样式。
 */
export function preprocessCallouts(md: string): string {
    return md.replace(CALLOUT_RE, (_full, prefix: string, block: string) => {
        // 拆分连续 blockquote 段（之间有空行）
        const segments: string[][] = [[]];
        for (const line of block.split("\n")) {
            if (!line.startsWith(">")) {
                if (segments[segments.length - 1].length > 0) {
                    segments.push([]);
                }
                continue;
            }
            segments[segments.length - 1].push(line);
        }
        // 处理每段
        const rendered: string[] = [];
        for (const seg of segments) {
            if (!seg.length) continue;
            const first = seg[0].replace(/^>\s?/, "");
            const fm = first.match(/^\[!(\w+)\]\s*([^\n]*)$/);
            if (!fm) continue;
            const type = fm[1].toLowerCase();
            if (!CALLOUT_TYPES.has(type)) continue;
            const title = fm[2].trim();
            const bodyLines = seg.slice(1).map((l) => l.replace(/^>\s?/, ""));
            const titleHtml = title
                ? `<div class="callout-title"><span class="callout-icon"></span><span>${title}</span></div>`
                : "";
            // N1 修复：callout 正文需渲染 Markdown（Obsidian 兼容保真）。
            // 外层 renderMarkdown 会把整块 <blockquote> 当裸 HTML 原样保留，
            // 因此 body 内的 **加粗** / `代码` / 列表必须在预处理阶段先渲染。
            const bodyMd = bodyLines.join("\n");
            const bodyHtml = bodyMd.trim()
                ? (marked.parse(bodyMd, { async: false }) as string)
                : "";
            rendered.push(`<blockquote class="callout callout-${type}">${titleHtml}<div class="callout-body">${bodyHtml}</div></blockquote>`);
        }
        if (!rendered.length) return prefix;
        return prefix + rendered.join("\n") + "\n";
    });
}

/**
 * Callout 变换记录（供 preview.ts 的行号映射用）。
 *
 * preprocessCallouts 会把 `> [!type]` 块替换为 HTML，替换串与源块的
 * 行数可能不同——行号映射需要知道每个块的源行号、源行数与替换串，
 * 才能把预处理后文本的行号换算回原始 markdown 的行号。
 */
export interface CalloutTransform {
    /** 源块在输入文本中的起始行（1-based） */
    startLine: number;
    /** 源块占用的行数 */
    rawLines: number;
    /** 替换串（与 preprocessAll 输出中的对应片段逐字节一致） */
    replacement: string;
}

/** 找出所有 callout 块的变换记录（与 preprocessCallouts 使用同一正则，顺序一致） */
export function findCalloutTransforms(md: string): CalloutTransform[] {
    const re = new RegExp(CALLOUT_RE.source, "g");
    const out: CalloutTransform[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(md))) {
        // m.index 指向前缀 \n（属于上一行的行尾），块内容真正起始在 m[1] 之后，
        // 行号需按内容起点算（否则相对真实行号偏 1）
        let line = 1;
        const contentOffset = m.index + m[1].length;
        for (let i = 0; i < contentOffset; i++) if (md.charCodeAt(i) === 10) line++;
        const rawLines = m[0].split("\n").length;
        out.push({ startLine: line, rawLines, replacement: preprocessCallouts(m[0]) });
    }
    return out;
}

// ============================================================================
// Frontmatter
// ============================================================================

// F17 修复：支持 CRLF（Windows）与 LF 换行
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

export interface Frontmatter {
    raw: string;
    data: Record<string, unknown>;
}

/** 极简 YAML 解析器（key: value 形式 + 缩进列表），足够覆盖 Obsidian 常用字段 */
export function parseFrontmatter(md: string): { frontmatter: Frontmatter | null; body: string } {
    const m = md.match(FRONTMATTER_RE);
    if (!m) return { frontmatter: null, body: md };
    const raw = m[1];
    const data: Record<string, unknown> = {};
    for (const line of raw.split("\n")) {
        const idx = line.indexOf(":");
        if (idx < 1) continue;
        const key = line.slice(0, idx).trim();
        let value: string = line.slice(idx + 1).trim();
        // 移除引号
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        // 简化：仅按行；如果 key 重复则变为数组（不支持，留作后续）
        data[key] = value;
    }
    return { frontmatter: { raw, data }, body: md.slice(m[0].length) };
}

// ============================================================================
// 图片资产复制
// ============================================================================

export interface ImageDropResult {
    /** 重写后的 markdown 引用文本（追加到当前文档） */
    markdown: string;
    /** 复制的资产路径（绝对路径或 mock 路径） */
    assetPath: string;
}

/**
 * 把拖入的 File 对象持久化为 assets 目录下的图片，并返回 markdown 引用。
 * 实际写入由 binding `copyImageAsset` 完成。这里仅产出资产名。
 */
export async function persistImageAsset(
    file: File,
    copyFn: (suggestedName: string, base64: string) => Promise<string>,
    bufferToBase64: (buf: ArrayBuffer) => string
): Promise<ImageDropResult> {
    const buf = await file.arrayBuffer();
    const b64 = bufferToBase64(buf);
    // 简单文件名 = timestamp + 原名 hash
    const ts = Date.now().toString(36);
    const safe = file.name.replace(/[^\w.\-]/g, "_");
    const assetPath = await copyFn(`assets/${ts}_${safe}`, b64);
    const md = `\n![${file.name}](${assetPath})\n`;
    return { markdown: md, assetPath: assetPath };
}

// ============================================================================
// Pipeline: 一站式预处理
// ============================================================================

export function preprocessAll(md: string): string {
    const { body } = parseFrontmatter(md);
    let s = body;
    // Callout 必须先于 wiki 预处理（避免在 callout 体内误识别 [[]]）
    s = preprocessCallouts(s);
    s = preprocessWikiLinks(s);
    return s;
}
