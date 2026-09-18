// errcode.ts — 错误码提取与前端常量化（审计 R2-F1）
//
// Go 侧所有对外暴露的 binding error 在文案前挂 `[code]` 前缀
// （fileio.go / links.go / app.go），前端经本模块的 errCode() 解
// 出后做精确 switch，替代旧的 `e.message.includes("...")` 子串
// 匹配。
//
// 错误码清单（与 Go 端 const 严格对应；改码前先双改）：
//   fileio.CodeNotFound         → "file_not_found"
//   fileio.CodeIsBinary         → "is_binary"
//   fileio.CodeTooLarge         → "too_large"
//   fileio.CodeNotRegular       → "not_regular"
//   fileio.CodeExternalModified → "external_modified"
//   fileio.CodeInvalidAsset     → "invalid_asset"
//   links.CodeSVGDisabled       → "svg_disabled"
//   links.CodeEmptyTarget       → "empty_target"
//   links.CodeNoBase            → "no_base"
//   links.CodeNotLocal          → "not_local"
//   links.CodeNotFile           → "not_file"
//   links.CodeNotEditable       → "not_editable"
//   links.CodeMalformedPath     → "malformed_path"
//   main.CodeEmptyPath          → "empty_path"
//   main.CodeAppNotReady        → "app_not_ready"
//   main.CodeEmptyImageData     → "empty_image_data"

/** 错误码正则：匹配 `e.message` 开头的 `[a-z0-9_]+` 块。 */
const CODE_RE = /^\[([a-z][a-z0-9_]*)\]/;

/**
 * 提取 err.message 开头的错误码。无码或非 Error 对象返回 null。
 *
 * 注意：Wails 绑定 error 经 JSON 序列化后到达前端时，wrap 链已丢失
 * （后端 wrap 在序列化时压平为字符串前缀），所以这里只看 err.message
 * 的首位 `[code]` 块。Go 端用 `err.Error()` 输出会保留 wrap，但跨
 * IPC 边界后只剩字符串。
 */
export function errCode(e: unknown): string | null {
    if (!(e instanceof Error)) return null;
    const m = CODE_RE.exec(e.message);
    return m ? m[1] : null;
}

/** errCode === target 的便利判定。 */
export function hasCode(e: unknown, code: string): boolean {
    return errCode(e) === code;
}

// ============================================================================
// 错误码常量（前端 switch 用；与 Go 端 const 严格对应，名字也一致）
// ============================================================================
export const EC = {
    FileNotFound: "file_not_found",
    IsBinary: "is_binary",
    TooLarge: "too_large",
    NotRegular: "not_regular",
    ExternalModified: "external_modified",
    InvalidAsset: "invalid_asset",
    SVGDisabled: "svg_disabled",
    EmptyTarget: "empty_target",
    NoBase: "no_base",
    NotLocal: "not_local",
    NotFile: "not_file",
    NotEditable: "not_editable",
    MalformedPath: "malformed_path",
    EmptyPath: "empty_path",
    AppNotReady: "app_not_ready",
    EmptyImageData: "empty_image_data",
} as const;

export type ErrorCode = typeof EC[keyof typeof EC];
