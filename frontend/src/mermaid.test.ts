// mermaid.test.ts — Mermaid 懒加载渲染单元测试（v0.2.8）
//
// 通过 setMermaidLoader 接缝注入 fake 模块，jsdom/node 环境不需要真实
// 下载 939KB gzip 的 mermaid chunk；真路由（v11 import）在 dev/E2E 中验证。

import {
    renderMermaid,
    clearMermaidCache,
    mermaidCacheSize,
    setMermaidLoader,
} from "./mermaid";

// ============================================================================
// 共享 fake loader 工厂
// ============================================================================

interface FakeMod {
    initialize: (cfg: { startOnLoad?: boolean; securityLevel?: string; theme?: string; fontFamily?: string }) => void;
    render: (id: string, code: string, container: HTMLElement) => Promise<{ svg: string }>;
    __initCalls: Array<Record<string, unknown>>;
    __renderCalls: Array<{ id: string; code: string }>;
    __initTheme: string | null;
}

function makeFakeMod(opts?: { failOn?: RegExp }): FakeMod {
    const mod: FakeMod = {
        __initCalls: [],
        __renderCalls: [],
        __initTheme: null,
        initialize(cfg) {
            this.__initCalls.push({ ...cfg });
            this.__initTheme = cfg.theme ?? null;
        },
        async render(id, code, container) {
            this.__renderCalls.push({ id, code });
            if (opts?.failOn?.test(code)) throw new Error("fake: syntax error");
            container.innerHTML = `<svg data-fake-id="${id}"><text>${code.length}b</text></svg>`;
            return { svg: container.innerHTML };
        },
    };
    return mod;
}

// 每个测试前清空 loader 与缓存
function reset(): void {
    setMermaidLoader(null);
    clearMermaidCache();
}

let pass = 0; let fail = 0;
function assert(cond: boolean, msg: string) {
    if (cond) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg); }
}

// ============================================================================
(async () => {
console.log("mermaid.render — 基础渲染与缓存：");
{
    reset();
    const fake = makeFakeMod();
    setMermaidLoader(async () => fake as unknown as { initialize(c:any):void; render(id:string,code:string,container?:HTMLElement):Promise<{svg:string}> });
    const svg = await renderMermaid("graph TD; A-->B", "dark");
    assert(!!(svg?.includes("<svg") && svg.includes("data-fake-id=")), "首次渲染返回 svg 字符串");
    assert(fake.__renderCalls.length === 1, "首次渲染触发一次 render 调用");
    assert(mermaidCacheSize() === 1, "缓存条目数 = 1");

    const svg2 = await renderMermaid("graph TD; A-->B", "dark");
    assert(svg2 === svg, "二次同 code+theme 命中缓存返回同一字符串");
    assert(fake.__renderCalls.length === 1, "命中缓存不再调用 render");
}

console.log("mermaid.render — 主题隔离：");
{
    reset();
    const fake = makeFakeMod();
    setMermaidLoader(async () => fake as unknown as { initialize(c:any):void; render(id:string,code:string,container?:HTMLElement):Promise<{svg:string}> });
    await renderMermaid("graph TD; A-->B", "dark");
    await renderMermaid("graph TD; A-->B", "light");
    assert(fake.__renderCalls.length === 2, "不同主题视为不同 key，两次渲染");
    assert(fake.__initCalls.length >= 2, "主题切换触发重新 initialize");
    const themes = fake.__initCalls.map((c) => c.theme);
    assert(themes.includes("dark") && themes.includes("default"), "应用主题映射到 mermaid 主题（dark / default）");
    assert(fake.__initCalls.some((c) => c.securityLevel === "strict"), "initialize 配置 securityLevel=strict");
    assert(fake.__initCalls.every((c) => c.startOnLoad === false), "initialize 配置 startOnLoad=false");
    assert(mermaidCacheSize() === 2, "缓存按主题各自保留（dark + light）");
}

console.log("mermaid.render — 错误降级：");
{
    reset();
    const fake = makeFakeMod({ failOn: /syntax-broken/ });
    setMermaidLoader(async () => fake as unknown as { initialize(c:any):void; render(id:string,code:string,container?:HTMLElement):Promise<{svg:string}> });
    const ok = await renderMermaid("graph TD; A-->B", "dark");
    assert(ok !== null, "合法代码返回 svg");
    const bad = await renderMermaid("syntax-broken diagram", "dark");
    assert(bad === null, "语法错误返回 null（不抛、不缓存）");
    assert(mermaidCacheSize() === 1, "失败结果不进入缓存（合法图仍可命中）");
}

console.log("mermaid.render — 空代码与缓存清理：");
{
    reset();
    const fake = makeFakeMod();
    setMermaidLoader(async () => fake as unknown as { initialize(c:any):void; render(id:string,code:string,container?:HTMLElement):Promise<{svg:string}> });
    assert(await renderMermaid("", "dark") === null, "空代码返回 null");
    assert(await renderMermaid("   ", "dark") === null, "纯空白代码返回 null（trim）");
    await renderMermaid("graph TD; A-->B", "dark");
    assert(mermaidCacheSize() === 1, "渲染成功后缓存条目存在");
    clearMermaidCache();
    assert(mermaidCacheSize() === 0, "clearMermaidCache 清空缓存");
}

console.log("mermaid.render — LRU 上限：");
{
    reset();
    const fake = makeFakeMod();
    setMermaidLoader(async () => fake as unknown as { initialize(c:any):void; render(id:string,code:string,container?:HTMLElement):Promise<{svg:string}> });
    // 64 条上限：连续 65 个不同图应淘汰最旧
    for (let i = 0; i < 65; i++) await renderMermaid(`g${i}`, "dark");
    assert(mermaidCacheSize() === 64, "LRU 上限 64 强制生效");
    // touch g0：再请求一次让它变最新
    await renderMermaid("g0", "dark");
    // 插入第 66 条：应淘汰当前最旧（g1）
    await renderMermaid("g65", "dark");
    assert(mermaidCacheSize() === 64, "LRU 维持上限");
}

console.log("mermaid.render — loader 失败：");
{
    reset();
    setMermaidLoader(async () => { throw new Error("network down"); });
    const r = await renderMermaid("graph TD; A-->B", "dark");
    assert(r === null, "loader 抛错 → 返回 null（调用方降级展示）");
    assert(mermaidCacheSize() === 0, "失败结果不进缓存");
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
})();
