// mermaid.ts — Mermaid 图表懒加载渲染（v0.2.8）
//
// 性能与安全设计（v0.2.6 评估报告实测依据）：
//   - 启动 ≈ 0：动态 import("mermaid")，主 JS 不内联图表库（mermaid 11.17.2
//     UMD 3.57MB / ESM 入口 30KB + 按图种 chunks 共 939KB gzip，按需下载）
//   - 图级缓存 Map<theme+code, svg>：切 tab / 撤销重做 / 主题切换前同图零开销
//   - renderGen 竞态防护：调用方负责丢弃过期结果（详见 preview.ts）
//   - securityLevel: strict：禁用 click 回调与危险 HTML，href 协议白名单
//   - 失败降级：语法错误返回 null，调用方展示 .is-error 提示并保留原码
//   - 测试接缝 setMermaidLoader：node/jsdom 注入 fake loader，避免真实加载
//
// 已知限制（与评估报告一致）：
//   - 内存占用 +30–80MB（首次动态 import 后常驻）；对超长会话的极端图量
//     场景，留 LRU 64 兜底
//   - 首次出图 100–300ms 加载 + 50–500ms 渲染（受图复杂度影响）

export type MermaidTheme = "dark" | "light";

/** 应用主题 → mermaid 主题映射（mermaid 不叫 light，标准主题名 default） */
const MM_THEME: Record<MermaidTheme, "dark" | "default"> = {
    dark: "dark",
    light: "default",
};

/** 我们实际只用到的 mermaid API 形状（default export mermaid 上有 initialize/render） */
interface MermaidLike {
    initialize(config: Record<string, unknown>): void;
    render(id: string, code: string, container?: HTMLElement): Promise<{ svg: string }>;
}

/**
 * 测试接缝：注入自定义 loader（如 fake）替代真实动态 import。
 * 设回 null 即恢复真实 dynamic import。
 */
type Loader = () => Promise<MermaidLike>;
let loader: Loader | null = null;
export function setMermaidLoader(fn: Loader | null): void {
    loader = fn;
    modPromise = null; // 切换 loader 后重置单例
    initializedTheme = null;
}

// ============================================================================
// 模块单例与 initialize
// ============================================================================

let modPromise: Promise<MermaidLike | null> | null = null;
let initializedTheme: MermaidTheme | null = null;
/** mermaid.render 要求的唯一 id；递增避免同 id 重渲染时画布冲突 */
let renderSeq = 0;

function loadMermaid(theme: MermaidTheme): Promise<MermaidLike | null> {
    if (loader) {
        return Promise.resolve()
            .then(() => loader!())
            .then((mod) => {
                ensureInitialized(mod, theme);
                return mod;
            })
            .catch(() => null);
    }
    if (!modPromise) {
        // 真实路径：动态 import() 由 vite 自动分包为主 chunk 之外的独立
        // chunk，首字节不下载、首渲染不出图时不付出任何代价
        modPromise = import("mermaid")
            .then((m) => {
                // mermaid 11 ESM 是 default export（Mermaid interface 实例）
                const mod = (m as unknown as { default?: MermaidLike }).default ?? (m as unknown as MermaidLike);
                ensureInitialized(mod, theme);
                return mod;
            })
            .catch(() => null);
    } else if (initializedTheme !== theme) {
        // 模块已加载但主题变了：重新 initialize（廉价，仅赋值配置对象）
        modPromise.then((mod) => mod && ensureInitialized(mod, theme));
    }
    return modPromise;
}

function ensureInitialized(mod: MermaidLike, theme: MermaidTheme): void {
    if (initializedTheme === theme) return;
    const fontFamily = (typeof getComputedStyle === "function"
        ? getComputedStyle(document.documentElement).getPropertyValue("--font-mono")?.trim()
        : "") || "ui-monospace, monospace";
    mod.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: MM_THEME[theme],
        fontFamily,
    });
    initializedTheme = theme;
}

// ============================================================================
// 图级缓存（LRU 64）
// ============================================================================

const CACHE_MAX = 64;
const svgCache = new Map<string, string>();

function cacheKey(theme: MermaidTheme, code: string): string {
    return theme + "\u0000" + code;
}

/**
 * 把 mermaid 源码渲染成 SVG 字符串。命中缓存直接返回；加载失败 / 语法错误
 * 返回 null。调用方负责渲染后的 HTML 注入与生命周期（renderGen 竞态防护）。
 */
export async function renderMermaid(code: string, theme: MermaidTheme): Promise<string | null> {
    const trimmed = code.trim();
    if (!trimmed) return null;
    const key = cacheKey(theme, trimmed);
    const hit = svgCache.get(key);
    if (hit !== undefined) {
        // LRU touch
        svgCache.delete(key);
        svgCache.set(key, hit);
        return hit;
    }
    const mod = await loadMermaid(theme);
    if (!mod) return null;
    const id = `mmd-${++renderSeq}-${Date.now()}`;
    // 临时容器：mermaid 11 render 需要 DOM 锚点；渲染后立即移除避免污染文档
    const tmp = document.createElement("div");
    tmp.style.position = "absolute";
    tmp.style.visibility = "hidden";
    tmp.style.pointerEvents = "none";
    document.body.appendChild(tmp);
    let svg: string | null = null;
    try {
        const res = await mod.render(id, trimmed, tmp);
        svg = (res && typeof res === "object" && "svg" in res ? res.svg : null) || tmp.innerHTML;
    } catch {
        svg = null;
    } finally {
        tmp.remove();
    }
    if (svg) {
        if (svgCache.size >= CACHE_MAX) {
            const oldest = svgCache.keys().next().value;
            if (oldest !== undefined) svgCache.delete(oldest);
        }
        svgCache.set(key, svg);
    }
    return svg;
}

/** 清缓存（主题切换、设置变更等场景；下次 renderMermaid 重新生成） */
export function clearMermaidCache(): void {
    svgCache.clear();
}

/** 测试/调试：当前缓存条目数 */
export function mermaidCacheSize(): number {
    return svgCache.size;
}
