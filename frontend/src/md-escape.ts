// md-escape.ts — 图片插入 Markdown 时的转义与编码（#9 修复）
//
// 背景：main.ts 的 onImageDrop 曾直接拼接 `![${file.name}](${assetPath})`：
//   - 文件名含 [ ] 时破坏链接语法（如 "shot [1].png" → 渲染断裂）；
//   - 文档目录含空格 / 括号 / 反斜杠时，链接目标被 Markdown 解析器截断；
//   - Windows 路径的反斜杠在 Markdown URL 中是转义前缀，必须归一为正斜杠。
// 抽成纯函数便于表驱动测试，main.ts 只负责调用。
//
// 转义规则依据 CommonMark：
//   - 链接文本（alt）中仅 [ ] 需要转义，反斜杠本身需先转义；
//   - 链接目标（URL）中的空格与不平衡括号必须百分号编码。

/** 转义图片 alt 文本：反斜杠与方括号加反斜杠前缀，其余字符（含括号）保持原样。 */
export function escapeImageAlt(alt: string): string {
    return alt.replace(/\\/g, "\\\\").replace(/[[\]]/g, "\\$&");
}

/** 归一化图片路径分隔符：反斜杠 → 正斜杠（Windows 兼容，Go 侧同样接受正斜杠）。 */
export function normalizeImagePath(p: string): string {
    return p.replace(/\\/g, "/");
}

/**
 * 百分号编码图片链接目标。
 *
 * 策略：先编码字面 `%` 再编码空格 / 括号，保证幂等正确性——
 * 含字面 "%20" 的文件名编码为 "%2520"，浏览器解码一次恰好还原；
 * 含空格的路径编码为 "%20"，解码一次得到空格。两种输入都自洽。
 * `/` 与非 ASCII 字符（中文等）保持原样，保持路径可读性。
 */
export function encodeImageUrl(url: string): string {
    return normalizeImagePath(url)
        .replace(/%/g, "%25")
        .replace(/ /g, "%20")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29");
}

/** 组合：生成一条语法安全的 Markdown 图片语法（不含前后换行，由调用方控制布局）。 */
export function buildImageMarkdown(alt: string, path: string): string {
    return `![${escapeImageAlt(alt)}](${encodeImageUrl(path)})`;
}
