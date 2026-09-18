// errcode.test.ts — 错误码解析的契约守护（审计 R2-F1）
//
// 锁三类契约：
//   1. errCode() 正则解出 `[code]` 块；
//   2. errCode 不匹配非 Error / 非 code 形态的输入；
//   3. EC 常量与 Go 端 const 名字一致（防漂移）。
//
// 端到端的 "[code] message" 形态由 Go 端 TestErrorTextContractForFrontend
// + TestErrorCodeOf_Wrapped 守护；本文件守护前端解析层。

import { errCode, hasCode, EC } from "./errcode";

let pass = 0;
let fail = 0;
function assert<T>(actual: T, expected: T, msg: string): void {
    if (actual === expected) {
        pass++;
        console.log("  ✓ " + msg);
    } else {
        fail++;
        console.log("  ✗ " + msg + ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
    }
}
function assertNull<T>(actual: T, msg: string): void {
    if (actual === null || actual === undefined) {
        pass++;
        console.log("  ✓ " + msg);
    } else {
        fail++;
        console.log("  ✗ " + msg + ` (got ${JSON.stringify(actual)}, want null)`);
    }
}

console.log("errCode 基础解析：");
assert(errCode(new Error("[file_not_found] file not found")), "file_not_found", "解出 file_not_found");
assert(errCode(new Error("[external_modified] file modified by another program")), "external_modified", "解出 external_modified");
assert(errCode(new Error("[is_binary] contains NUL byte: /tmp/x")), "is_binary", "解出 is_binary（wrap 后路径/数字不影响）");

console.log("\nerrCode 边界：");
assertNull(errCode(new Error("plain message")), "无码错误返回 null");
assertNull(errCode(new Error("")), "空字符串返回 null");
assertNull(errCode(undefined), "undefined 返回 null");
assertNull(errCode(null), "null 返回 null");
assertNull(errCode("string err"), "string 返回 null");
assertNull(errCode(42), "number 返回 null");
assertNull(errCode({ message: "[code] x" }), "普通对象（非 Error 实例）返回 null");
assertNull(errCode(new Error("[Code] x")), "[Code] 大写开头不匹配（code 约定小写）");
assertNull(errCode(new Error("[] x")), "空 code 不匹配");
assertNull(errCode(new Error("[with space] x")), "code 含空格不匹配");

console.log("\nhasCode 便利判定：");
assert(hasCode(new Error("[file_not_found] x"), "file_not_found"), true as any, "匹配码返回 true");
assert(hasCode(new Error("[file_not_found] x"), "is_binary"), false as any, "不匹配码返回 false");
assert(hasCode(null, "file_not_found"), false as any, "null err 返回 false");

console.log("\nEC 常量与 Go 端 const 对齐：");
const expected: Record<string, string> = {
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
};
for (const k of Object.keys(expected)) {
    assert(EC[k as keyof typeof EC], expected[k], `${k} = "${expected[k]}"`);
}

console.log("\nEC 与 errCode 联动：");
{
    const e = new Error("[" + EC.FileNotFound + "] file not found");
    assert(errCode(e), EC.FileNotFound, "EC.FileNotFound 走 errCode 还原");
}
{
    const conflict = new Error("[" + EC.ExternalModified + "] file modified by another program");
    assert(hasCode(conflict, EC.ExternalModified), true as any, "EC.ExternalModified 走 hasCode 判保存冲突");
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) {
    process.exit(1);
}
