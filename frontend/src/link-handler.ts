// link-handler.ts — 预览区链接的分类（纯函数，无 DOM / 无 binding 依赖）
//
// 存在理由：预览区跑在 WebView2 的 http://wails.localhost 源上，任何形如
// [文本](../a.md) 的链接若放任浏览器默认行为，都会让 WebView **就地导航**到
// http://wails.localhost/a.md —— assetserver 查无此资源返回 404，整个前端
// SPA 被卸载（界面消失、未保存内容丢失，只能杀进程）。
//
// 因此所有链接点击都被拦截，先经 classifyHref 分类，再由主应用决定动作。
// 本模块只做「这是什么链接」的判断，不决定「点了会怎样」，便于单测。

export type LinkKind =
    | "external" // http(s)：系统浏览器
    | "mail"     // mailto / tel：系统邮件/电话
    | "anchor"   // #标题：预览区内滚动
    | "local"    // 本地相对/绝对路径：应用内打开或交系统程序
    | "unsafe";  // javascript: / data: 等：忽略（渲染层通常已剥掉 href）

export interface ParsedLink {
    kind: LinkKind;
    /** 原始 href（未做任何加工，供右键复制与外部打开使用） */
    href: string;
    /** 去掉 #锚点 与 ?查询 后的目标部分（百分号编码保留，由 Go 侧解码） */
    target: string;
    /** 锚点部分（无则空串） */
    anchor: string;
}

// 危险协议：即便渲染层漏网也不能放行（DOMPurify 已剥掉这类 href，这里双保险）
const UNSAFE_RE = /^(?:javascript|data|vbscript|blob|about):/i;
const HTTP_RE = /^https?:\/\//i;
const MAIL_RE = /^(?:mailto|tel):/i;

/**
 * 按 URL 语法切出锚点与查询串：path?query#fragment。
 *
 * 先切 #（其后全部属于 fragment，fragment 内允许出现 ?），再裁掉 ? 之后的查询串。
 * Windows 文件名不允许 # 与 ?，因此不会出现"路径里的 # 被误切"。
 */
function splitHref(href: string): { target: string; anchor: string } {
    let rest = href;
    let anchor = "";
    const hash = rest.indexOf("#");
    if (hash >= 0) {
        anchor = rest.slice(hash + 1);
        rest = rest.slice(0, hash);
    }
    const query = rest.indexOf("?");
    if (query >= 0) rest = rest.slice(0, query);
    return { target: rest, anchor };
}

/**
 * 判断一个 href 属于哪类链接。
 *
 * 空串按 unsafe 处理（调用方直接忽略），避免出现"点了个不该点的东西"。
 */
export function classifyHref(href: string): ParsedLink {
    const raw = (href ?? "").trim();
    if (!raw) return { kind: "unsafe", href: raw, target: "", anchor: "" };
    if (UNSAFE_RE.test(raw)) return { kind: "unsafe", href: raw, target: raw, anchor: "" };

    const { target, anchor } = splitHref(raw);
    if (HTTP_RE.test(raw)) return { kind: "external", href: raw, target, anchor };
    if (MAIL_RE.test(raw)) return { kind: "mail", href: raw, target, anchor };
    if (raw.startsWith("#")) return { kind: "anchor", href: raw, target: "", anchor };
    // 其余一律视作本地路径：相对路径、盘符绝对路径、UNC、file:// 都由 Go 侧解析
    return { kind: "local", href: raw, target, anchor };
}

/**
 * 生成标题锚点 id（GitHub 风格）。
 *
 * 背景：marked v5+ 已移除内置 headerIds，`## 二级标题` 只输出无 id 的 <h2>，
 * 于是 `[跳转](#二级标题)` 即便不导航也"点了没反应"。预览渲染后由本函数
 * 为标题补 id，锚点链接才能真正滚动。
 *
 * 规则：去除标点、空白折叠为连字符、保留 Unicode 字母数字（中文标题可用）。
 */
export function slugifyHeading(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "") // 去标点，保留字母/数字/空白/连字符
        .replace(/\s+/g, "-");
}

/**
 * 为一批标题生成互不重复的 id（文档顺序，重复时加 -2 / -3 后缀）。
 * 返回与输入等长的 id 数组；空 slug（全是标点）回退为 section-N，保证锚点可用。
 */
export function assignHeadingIds(texts: string[]): string[] {
    const used = new Map<string, number>();
    return texts.map((text, i) => {
        let base = slugifyHeading(text) || `section-${i + 1}`;
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        if (seen > 0) base = `${base}-${seen + 1}`;
        return base;
    });
}
