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

/**
 * 保存文件，返回保存后磁盘文件的真实 mtime（Unix 秒），供 Tab.diskMtime
 * 记账（P0-5：旧版前端用 Date.now() 伪造，与磁盘真实 mtime 有时钟偏差）。
 *
 * expectMtime > 0 时 Go 侧检测外部修改：文件被其他程序改过则抛
 * ErrExternalModified 错误，调用方应弹冲突确认后以 0 强制覆盖。
 */
export async function saveFile(path: string, content: string, expectMtime = 0): Promise<number> {
    return await bind("SaveFile")(path, content, expectMtime);
}

export async function saveFileAs(suggested: string, content: string): Promise<string> {
    return await bind("SaveFileAs")(suggested, content);
}

/** 弹出另存为对话框，仅取路径（写入由 saveFile 完成，统一走 mtime 冲突检测） */
export async function pickSavePath(suggested: string): Promise<string> {
    return await bind("SaveDialog")(suggested);
}

export async function getConfig(): Promise<ConfigT.Config> {
    return await bind("GetConfig")();
}

export async function pushRecent(path: string): Promise<ConfigT.Config> {
    return await bind("PushRecent")(path);
}

/**
 * 把图片资产写入当前文档所在目录的 assets/ 下（P0-2 新契约）。
 *
 * 旧签名让前端传完整 targetPath，等价于任意文件写入原语；现在只传
 * 「文档绝对路径 + 纯文件名」，写入位置由 Go 侧从文档目录推导并校验
 * 扩展名白名单 / 大小上限。返回后端落盘的绝对路径。
 */
export async function copyImageAsset(baseFile: string, assetName: string, base64Data: string): Promise<string> {
    return await bind("CopyImageAsset")(baseFile, assetName, base64Data);
}

// ============================================================================
// 链接与本地资源（v0.2.6：预览链接不再触发 WebView 导航）
// ============================================================================

/** 链接目标解析结果（对应 Go 侧 main.LinkTarget） */
export interface LinkTargetInfo {
    /** 绝对路径；不存在时是"应该在哪"的路径，供提示展示 */
    path: string;
    exists: boolean;
    /** markdown | text | other | dir | missing */
    kind: string;
    anchor: string;
}

/**
 * 解析 Markdown 链接目标。
 *
 * 这是预览链接不再"点一下就白屏"的关键：相对路径在 Go 侧换算成磁盘绝对路径，
 * 前端据此决定在应用内打开还是交系统程序，而不是交给 WebView 去导航。
 */
export async function resolveLocalPath(basePath: string, href: string): Promise<LinkTargetInfo> {
    return await bind("ResolveLocalPath")(basePath, href);
}

/** 用系统默认浏览器/邮件客户端打开外链（Go 侧校验 http/https/mailto/tel 白名单） */
export async function openExternal(url: string): Promise<void> {
    await bind("OpenExternal")(url);
}

/** 用系统默认程序打开本地文件（PDF / Excel / 图片等） */
export async function openPath(path: string): Promise<void> {
    await bind("OpenPath")(path);
}

/** 读取本地图片为 data URL，供预览区相对路径图片回填 */
export async function readLocalAsset(path: string): Promise<string> {
    return await bind("ReadLocalAsset")(path);
}

/**
 * 上报未保存标签数（审查 P1-11）。
 *
 * Go 侧 OnBeforeClose 是同步钩子，无法回询前端；dirty 计数变化时
 * 主动推给 Go，关闭窗口时据此决定是否弹原生确认框。
 */
export async function setUnsavedCount(n: number): Promise<void> {
    await bind("SetUnsavedCount")(n);
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
    SaveDialog: pickSavePath,
    GetConfig: getConfig,
    PushRecent: pushRecent,
    CopyImageAsset: copyImageAsset,
    ResolveLocalPath: resolveLocalPath,
    OpenExternal: openExternal,
    OpenPath: openPath,
    ReadLocalAsset: readLocalAsset,
    SetUnsavedCount: setUnsavedCount,
};
