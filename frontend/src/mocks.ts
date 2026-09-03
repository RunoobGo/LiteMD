// mocks.ts — 在浏览器/E2E 环境下模拟 Wails Go bindings 的实现
//
// 当运行在 Wails WebView 中时，wailsjs/go/main/App.js 会由 vite 优先匹配真实包；
// 这里是浏览器环境的兜底实现：把方法挂到 window.go 上供 main.ts 透明调用。

// 内存中的 mock 文件系统:E2E 测试可注入预置文件。
// 同时镜像到 sessionStorage,使 location.reload()/跳转后注入的文件仍存在
// (window 级注入会被刷新清空,无法验证"启动参数打开文件"链路)。
export interface MockFs {
    files: Map<string, string>;
    savedFiles: Array<{ path: string; content: string }>;
    /** 标记为目录的路径（用于验证 kind==="dir" 分支） */
    dirMarkers: Set<string>;
    /** OpenExternal 调用记录：E2E 据此断言外链没有触发页面导航 */
    externalOpens: string[];
    /** OpenPath 调用记录：E2E 据此断言"二次确认后才交系统程序" */
    systemOpens: string[];
    setFile(path: string, content: string): void;
    popLastSave(): { path: string; content: string } | undefined;
}

const MOCKFS_STORE_KEY = "__litemd__mockfs_store";

function loadPersistedFiles(): Map<string, string> {
    const m = new Map<string, string>();
    try {
        const raw = sessionStorage.getItem(MOCKFS_STORE_KEY);
        if (raw) for (const [p, c] of JSON.parse(raw) as [string, string][]) m.set(p, c);
    } catch { /* 损坏数据忽略 */ }
    return m;
}

class InMemoryMockFs implements MockFs {
    files = loadPersistedFiles();
    savedFiles: Array<{ path: string; content: string }> = [];
    /** 路径 → 上次 SaveFile 记账的 mtime（对齐 Go 侧冲突检测） */
    mtimes = new Map<string, number>();
    dirMarkers = new Set<string>();
    externalOpens: string[] = [];
    systemOpens: string[] = [];

    setFile(path: string, content: string) {
        this.files.set(path, content);
        try {
            sessionStorage.setItem(MOCKFS_STORE_KEY, JSON.stringify([...this.files]));
        } catch { /* 存储满等场景忽略 */ }
    }
    popLastSave() {
        return this.savedFiles.pop();
    }
}

const mockFs = new InMemoryMockFs();
(window as any).__litemd__mockfs = mockFs;

(window as any).go = {
    main: {
        App: {
            AppInfo: async () => ({
                name: "LiteMD",
                version: "0.2.8-mock",
                os: "browser-mock",
            }),
            // 契约来源：internal/config/config.go 的 config.Config
            // （theme/fontFamily/fontSize/recentFiles 四字段）。
            // 修改 Go 侧 Config 后必须同步此处，字段漂移会在 E2E 中产生误导。
            GetConfig: async () => ({
                theme: "dark",
                fontFamily: "system-ui",
                fontSize: 14,
                recentFiles: [],
            }),
            SetConfig: async () => {},
            // 文件关联场景的 mock:模拟"命令行带参启动"。
            // 优先读 URL 查询参数 ?open=<path>(跨刷新存在,最接近 argv 语义,
            // 消费后立即从地址栏移除,避免刷新重复打开);其次是 window 级注入。
            ConsumeStartupFile: async () => {
                const fromUrl = new URLSearchParams(location.search).get("open");
                const path: string | undefined =
                    fromUrl || ((window as any).__litemd__startupFile as string | undefined);
                if (!path) return { path: "", content: "", modified: 0 };
                if (fromUrl) history.replaceState(null, "", location.pathname);
                (window as any).__litemd__startupFile = undefined;
                const content = mockFs.files.get(path);
                if (content === undefined) {
                    throw new Error(`mock: file not found: ${path}`);
                }
                return { path, content, modified: Math.floor(Date.now() / 1000) };
            },
            OpenFile: async (path: string) => {
                const content = mockFs.files.get(path);
                if (content === undefined) {
                    throw new Error(`mock: file not found: ${path}`);
                }
                return { path, content, modified: Math.floor(Date.now() / 1000) };
            },
            OpenDialog: async () => {
                // prompt 在部分 E2E/无头环境抛异常（"prompt() is not supported"），
                // 降级返回默认路径而非让错误冒泡成「打开失败」对话框
                try {
                    const ans = window.prompt("mock: 选择要打开的文件路径", "/mock/note.md");
                    return ans ?? "";
                } catch { return "/mock/note.md"; }
            },
            SaveDialog: async () => {
                try {
                    const ans = window.prompt("mock: 输入另存为路径", "/mock/untitled.md");
                    return ans ?? "";
                } catch { return "/mock/untitled.md"; }
            },
            SaveFile: async (path: string, content: string, expectMtime?: number) => {
                // 对齐 Go 侧 P0-5 契约：expectMtime>0 时校验记账 mtime，
                // 不符抛"modified by another program"（前端弹覆盖确认）
                if (expectMtime && expectMtime > 0) {
                    const prev = mockFs.mtimes.get(path);
                    if (prev !== undefined && prev !== expectMtime) {
                        throw new Error(`mock: file modified by another program: ${path}`);
                    }
                }
                mockFs.savedFiles.push({ path, content });
                mockFs.files.set(path, content);
                const mt = Math.floor(Date.now() / 1000);
                mockFs.mtimes.set(path, mt);
                return mt;
            },
            SaveFileAs: async (_suggested: string, _content: string) => {
                // 同上：prompt 不可用时降级默认路径，避免「另存为失败」误报
                let ans: string | null;
                try {
                    ans = window.prompt("mock: 输入新路径", "/mock/saved.md");
                } catch {
                    ans = "/mock/saved.md";
                }
                if (!ans) return "";
                mockFs.savedFiles.push({ path: ans, content: _content });
                mockFs.files.set(ans, _content);
                return ans;
            },
            PushRecent: async (path: string) => ({
                theme: "dark",
                fontFamily: "system-ui",
                fontSize: 14,
                recentFiles: [path],
            }),
            // ---- v0.2.6：链接解析 / 外部打开 / 本地资源 ----
            // 契约来源：internal/links/links.go + app.go 的 ResolveLocalPath。
            // mock 用类 Unix 的纯字符串路径运算复刻 Go 侧行为（含 .. 折叠与
            // file:// 剥离），E2E 才能验证"点了相对链接会打开正确的文件"。
            ResolveLocalPath: async (baseFile: string, href: string) => {
                const raw = (href ?? "").trim();
                if (!raw) throw new Error("link target is empty");
                // 先切 #锚点，再切 ?查询（与 Go 侧 splitAnchor 一致）
                let s = raw;
                let anchor = "";
                const hash = s.indexOf("#");
                if (hash >= 0) { anchor = s.slice(hash + 1); s = s.slice(0, hash); }
                const q = s.indexOf("?");
                if (q >= 0) s = s.slice(0, q);
                // 外部协议不走本地解析
                if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) && !/^[a-zA-Z]:[\\/]/.test(s)) {
                    throw new Error(`link target is not a local path: ${s}`);
                }
                if (s.toLowerCase().startsWith("file://")) {
                    const rest = s.slice(7);
                    s = rest.startsWith("/") ? rest.slice(1) : "//" + rest;
                }
                s = s.replace(/\\/g, "/");
                if (/^[a-zA-Z]:\//.test(s)) {
                    s = s.replace(/\/\.\.\//g, "/../"); // 盘符路径交给下面的 clean
                } else if (!s.startsWith("/")) {
                    if (!baseFile) throw new Error("base file path is empty");
                    const dir = baseFile.slice(0, Math.max(baseFile.lastIndexOf("/"), 0)) || "/";
                    s = dir + "/" + s;
                }
                // 路径 Clean：折叠 "." 与 ".."；每段先做百分号解码
                // （对齐 Go 侧 url.PathUnescape：marked 输出的中文 href 是编码形态）
                const out: string[] = [];
                for (const part of s.split("/")) {
                    if (part === "" || part === ".") continue;
                    if (part === "..") { out.pop(); continue; }
                    let seg = part;
                    try { seg = decodeURIComponent(part); } catch { /* 非法编码保留原样 */ }
                    out.push(seg);
                }
                const abs = (s.startsWith("/") ? "/" : "") + out.join("/");
                const content = mockFs.files.get(abs);
                const isDir = content === undefined && mockFs.dirMarkers.has(abs);
                // 扩展名必须落在最后一段文件名里取（无点时 lastIndexOf 为 -1，
                // 直接 slice 会取到末字符——这是初版 mock 的判定 bug）
                const lastSlash = Math.max(abs.lastIndexOf("/"), 0);
                const dot = abs.lastIndexOf(".");
                const ext = dot > lastSlash ? abs.slice(dot).toLowerCase() : "";
                const md = [".md", ".markdown", ".mdown", ".mkd", ".mkdn"].includes(ext);
                const txt = [".txt", ".text", ".log", ".csv", ".json", ".yaml", ".yml"].includes(ext);
                // 无扩展名：mock 内容均为文本，对齐 Go 侧 looksLikeText → markdown
                const kind = isDir
                    ? "dir"
                    : content === undefined
                        ? "missing"
                        : md || ext === ""
                            ? "markdown"
                            : txt ? "text" : "other";
                return { path: abs, exists: content !== undefined || isDir, kind, anchor };
            },
            // 记录调用，E2E 据此处断言"外链没有触发页面导航而是走了外部打开"
            OpenExternal: async (url: string) => {
                mockFs.externalOpens.push(url);
            },
            OpenPath: async (path: string) => {
                mockFs.systemOpens.push(path);
            },
            ReadLocalAsset: async (_targetPath: string) => {
                // mock 图片固定返回 1x1 PNG，便于断言 data URL 回填
                return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
            },
            CopyImageAsset: async (baseFile: string, assetName: string, base64Data: string) => {
                // 对齐 Go 侧新契约（P0-2）：baseFile 必须绝对路径（未保存文档
                // 前端已拦截，mock 专用 baseFile 传空串时落到 /mock/assets/）。
                // 旧版 mock 接受完整 targetPath，与真实 binding 行为漂移会掩盖缺陷。
                if (baseFile && !/^([A-Za-z]:)?[\\/]/.test(baseFile)) {
                    throw new Error(`mock: unsafe base file: not absolute: ${baseFile}`);
                }
                if (!assetName || /[\\/]/.test(assetName)) {
                    throw new Error(`mock: invalid asset name: ${assetName}`);
                }
                const dir = baseFile
                    ? baseFile.slice(0, Math.max(baseFile.lastIndexOf("/"), baseFile.lastIndexOf("\\")) + 1) + "assets/"
                    : "/mock/assets/";
                const targetPath = `${dir}${assetName}`;
                // mock：把 data uri 写入 mock FS，并把 base64 写到 targetPath
                const stripped = base64Data.startsWith("data:") ? base64Data.split(",")[1] ?? "" : base64Data;
                mockFs.files.set(targetPath, `<base64:${stripped.length}chars>`);
                mockFs.savedFiles.push({ path: targetPath, content: `<base64:${stripped.length}chars>` });
                return targetPath;
            },
            // 审查 P1-11：Go 侧 OnBeforeClose 守卫的计数上报。
            // mock 环境记录最近一次上报值，E2E 可据此断言 dirty 状态同步。
            SetUnsavedCount: async (n: number) => {
                (window as any).__litemd__unsavedCount = n;
            },
        },
    },
};

// E2E 测试可以监听这个事件，知道应用已就绪
document.dispatchEvent(new CustomEvent("litemd:mockfs:ready"));
export {};
