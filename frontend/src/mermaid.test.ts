// mermaid.test.ts — Mermaid 懒加载渲染单元测试（v0.2.8）
//
// 通过 setMermaidLoader 接缝注入 fake 模块，jsdom/node 环境不需要真实
// 下载 939KB gzip 的 mermaid chunk；真路由（v11 import）在 dev/E2E 中验证。

import {
    renderMermaid,
    clearMermaidCache,
    mermaidCacheSize,
    setMermaidLoader,
    setRenderTimeout,
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

function makeFakeMod(opts?: { failOn?: RegExp; hangOn?: RegExp }): FakeMod {
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
            if (opts?.hangOn?.test(code)) {
                // 模拟病态输入：永不 resolve（由 renderMermaid 的超时兜底）
                await new Promise(() => { /* never */ });
            }
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
    const r = await renderMermaid("graph TD; A-->B", "dark");
    assert(r.ok && r.svg.includes("<svg") && r.svg.includes("data-fake-id="), "首次渲染返回 svg 字符串");
    assert(fake.__renderCalls.length === 1, "首次渲染触发一次 render 调用");
    assert(mermaidCacheSize() === 1, "缓存条目数 = 1");

    const r2 = await renderMermaid("graph TD; A-->B", "dark");
    assert(r2.ok && r2.svg === r.svg, "二次同 code+theme 命中缓存返回同一字符串");
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
    assert(fake.__initCalls.every((c) => {
        const fc = c.flowchart as { htmlLabels?: boolean } | undefined;
        return fc?.htmlLabels === false;
    }), "initialize 配置 flowchart.htmlLabels=false（P1-6）");
    assert(mermaidCacheSize() === 2, "缓存按主题各自保留（dark + light）");
}

console.log("mermaid.render — 错误降级（区分语法错误与加载失败，P0-1）：");
{
    reset();
    const fake = makeFakeMod({ failOn: /syntax-broken/ });
    setMermaidLoader(async () => fake as unknown as { initialize(c:any):void; render(id:string,code:string,container?:HTMLElement):Promise<{svg:string}> });
    const ok = await renderMermaid("graph TD; A-->B", "dark");
    assert(ok.ok, "合法代码返回 ok");
    const bad = await renderMermaid("syntax-broken diagram", "dark");
    assert(!bad.ok && bad.reason === "syntax", "语法错误 → reason='syntax'（不抛、不缓存）");
    assert(mermaidCacheSize() === 1, "失败结果不进入缓存（合法图仍可命中）");
}

console.log("mermaid.render — 空代码与缓存清理：");
{
    reset();
    const fake = makeFakeMod();
    setMermaidLoader(async () => fake as unknown as { initialize(c:any):void; render(id:string,code:string,container?:HTMLElement):Promise<{svg:string}> });
    const e1 = await renderMermaid("", "dark");
    const e2 = await renderMermaid("   ", "dark");
    assert(!e1.ok && e1.reason === "empty", "空代码 → reason='empty'");
    assert(!e2.ok && e2.reason === "empty", "纯空白代码 → reason='empty'（trim）");
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

console.log("mermaid.render — loader 失败（区别于语法错误）：");
{
    reset();
    setMermaidLoader(async () => { throw new Error("network down"); });
    const r = await renderMermaid("graph TD; A-->B", "dark");
    assert(!r.ok && r.reason === "load", "loader 抛错 → reason='load'（调用方按加载失败提示）");
    assert(mermaidCacheSize() === 0, "失败结果不进缓存");
}

console.log("mermaid.render — 渲染超时（P1-6）：");
{
    reset();
    setRenderTimeout(80); // 缩短超时，测试不必真等 15s
    const fake = makeFakeMod({ hangOn: /hang/ });
    setMermaidLoader(async () => fake as unknown as { initialize(c:any):void; render(id:string,code:string,container?:HTMLElement):Promise<{svg:string}> });
    const r = await renderMermaid("hang forever", "dark");
    assert(!r.ok && r.reason === "timeout", "病态输入卡死 render → reason='timeout'（不永久挂起）");
    // 超时后队列恢复：后续渲染仍可进行
    const r2 = await renderMermaid("graph TD; A-->B", "dark");
    assert(r2.ok, "超时后串行队列不阻塞后续渲染");
    setRenderTimeout(15_000); // 恢复默认
}

console.log("mermaid.render — 串行队列（P1-6）：");
{
    reset();
    const fake = makeFakeMod();
    setMermaidLoader(async () => fake as unknown as { initialize(c:any):void; render(id:string,code:string,container?:HTMLElement):Promise<{svg:string}> });
    let inFlight = 0; let maxInFlight = 0;
    const origRender = fake.render.bind(fake);
    fake.render = async (id, code, container) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
            return await new Promise<{ svg: string }>((resolve) => setTimeout(() => resolve({ svg: `<svg data-fake-id="${id}"></svg>` }), 5));
        } finally {
            inFlight--;
            void origRender;
            void container;
        }
    };
    // 8 个图并发请求：应被串行化，任一时刻 in-flight ≤ 1
    await Promise.all(Array.from({ length: 8 }, (_, i) => renderMermaid(`q${i}`, "dark")));
    assert(maxInFlight === 1, `并发请求被串行化（峰值 in-flight = ${maxInFlight}，应为 1）`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
})();
