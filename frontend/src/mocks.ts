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
                version: "0.2.0-mock",
                os: "browser-mock",
            }),
            GetConfig: async () => ({
                theme: "dark",
                fontFamily: "system-ui",
                fontSize: 14,
                recentFiles: [],
                windowWidth: 1024,
                windowHeight: 768,
                keyMap: "default",
                customCssPath: "",
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
                const ans = window.prompt("mock: 选择要打开的文件路径", "/mock/note.md");
                return ans ?? "";
            },
            SaveDialog: async () => {
                const ans = window.prompt("mock: 输入另存为路径", "/mock/untitled.md");
                return ans ?? "";
            },
            SaveFile: async (path: string, content: string) => {
                mockFs.savedFiles.push({ path, content });
                mockFs.files.set(path, content);
            },
            SaveFileAs: async (_suggested: string, _content: string) => {
                const ans = window.prompt("mock: 输入新路径", "/mock/saved.md");
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
                windowWidth: 1024,
                windowHeight: 768,
                keyMap: "default",
                customCssPath: "",
            }),
            CopyImageAsset: async (targetPath: string, base64Data: string) => {
                // mock：把 data uri 写入 mock FS，并把 base64 写到 targetPath
                const stripped = base64Data.startsWith("data:") ? base64Data.split(",")[1] ?? "" : base64Data;
                mockFs.files.set(targetPath, `<base64:${stripped.length}chars>`);
                mockFs.savedFiles.push({ path: targetPath, content: `<base64:${stripped.length}chars>` });
                return targetPath;
            },
        },
    },
};

// E2E 测试可以监听这个事件，知道应用已就绪
document.dispatchEvent(new CustomEvent("litemd:mockfs:ready"));
export {};
