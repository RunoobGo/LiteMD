// file-ops.ts — 抽象出"打开/保存文件 + 推送最近文件"四件套
//
// 双模式：
//   - 浏览器/E2E：mocks.ts 注入 window.go.main.App
//   - 桌面应用：wailsjs/go/main/App 是自动生成的真实 binding
//
// 两者方法签名相同，运行时通过 fallback 选择

import { main as MainT, config as ConfigT } from "../wailsjs/go/models";

// 真实 binding 总是被打包（vite 会忽略运行时引用），所以可以放心静态导入
// 实际运行时如果存在 window.go.main.App，优先用它（mock 模式）
import * as wailsBindings from "../wailsjs/go/main/App";

function bind(name: string) {
    const w = window as any;
    const mock = w.go?.main?.App?.[name];
    if (typeof mock === "function") return mock;
    if (typeof (wailsBindings as any)[name] === "function") return (wailsBindings as any)[name];
    throw new Error(`binding ${name} not available`);
}

export async function openFile(path: string): Promise<MainT.FilePayload> {
    return await bind("OpenFile")(path);
}

export async function pickOpenPath(): Promise<string> {
    return await bind("OpenDialog")();
}

export async function saveFile(path: string, content: string): Promise<void> {
    await bind("SaveFile")(path, content);
}

export async function saveFileAs(suggested: string, content: string): Promise<string> {
    return await bind("SaveFileAs")(suggested, content);
}

export async function getConfig(): Promise<ConfigT.Config> {
    return await bind("GetConfig")();
}

export async function pushRecent(path: string): Promise<ConfigT.Config> {
    return await bind("PushRecent")(path);
}

export async function copyImageAsset(targetPath: string, base64Data: string): Promise<string> {
    return await bind("CopyImageAsset")(targetPath, base64Data);
}

// E2E 测试可读
declare global {
    interface Window {
        __litemd__bindings?: Record<string, (...args: any[]) => Promise<any>>;
    }
}
window.__litemd__bindings = {
    OpenFile: openFile,
    OpenDialog: pickOpenPath,
    SaveFile: saveFile,
    SaveFileAs: saveFileAs,
    GetConfig: getConfig,
    PushRecent: pushRecent,
    CopyImageAsset: copyImageAsset,
};
