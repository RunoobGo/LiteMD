// mocks.ts — 在浏览器/E2E 环境下模拟 Wails Go bindings 的实现
//
// 当运行在 Wails WebView 中时，wailsjs/go/main/App.js 会由 vite 优先匹配真实包；
// 这里是浏览器环境的兜底实现：把方法挂到 window.go 上供 main.ts 透明调用。

// 内存中的 mock 文件系统：E2E 测试可注入预置文件
export interface MockFs {
    files: Map<string, string>;
    savedFiles: Array<{ path: string; content: string }>;
    setFile(path: string, content: string): void;
    popLastSave(): { path: string; content: string } | undefined;
}

class InMemoryMockFs implements MockFs {
    files = new Map<string, string>();
    savedFiles: Array<{ path: string; content: string }> = [];

    setFile(path: string, content: string) {
        this.files.set(path, content);
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
