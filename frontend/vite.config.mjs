import { resolve } from "node:path";

/**
 * KaTeX 字体裁剪：只保留 woff2。
 *
 * katex.min.css 里每个 @font-face 都声明了 woff2 / woff / ttf 三档 fallback，
 * vite 会照单全收地把 60 个字体文件全部打包 —— 但浏览器只会下载首个支持的
 * 格式，woff 与 ttf 因此是 100% 的死重（实测 1.2MB 中约 1.0MB 属此类）。
 *
 * 运行环境是 Windows 11 的 WebView2（Chromium 内核），woff2 支持无死角，
 * 故在 CSS 进入打包流水线前剥掉另两档引用，vite 便不会再产出对应文件。
 * 实测：dist 2.2MB → 1.2MB。
 */
function katexWoff2Only() {
    return {
        name: "katex-woff2-only",
        enforce: "pre",
        transform(code, id) {
            if (!/katex[/\\]dist[/\\].*\.css$/.test(id)) return null;
            const stripped = code
                .replace(/,\s*url\([^)]*\.woff\)\s*format\(["']?woff["']?\)/gi, "")
                .replace(/,\s*url\([^)]*\.ttf\)\s*format\(["']?truetype["']?\)/gi, "");
            return { code: stripped, map: null };
        },
    };
}

/** @type {import('vite').UserConfig} */
export default {
    plugins: [katexWoff2Only()],
    // 双入口：
    //   - index.html : 生产模式（嵌入 Wails）
    //   - dev.html   : 浏览器/E2E 模式（mocks 注入 window.go）
    build: {
        rollupOptions: {
            input: {
                main: resolve(import.meta.dirname, "index.html"),
                dev: resolve(import.meta.dirname, "dev.html"),
            },
        },
    },
    server: {
        host: "127.0.0.1",
        port: 5173,
        strictPort: true,
    },
};
