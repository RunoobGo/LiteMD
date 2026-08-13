// dev-bootstrap.ts — 浏览器开发模式入口
//
// 与 main.ts 的差异：
//   - mocks.ts 必须在 file-ops 之前导入，注入 window.go
//   - 其余初始化逻辑委托给 main.ts

import "./mocks";
import "./style.css";

// 等待 DOM 就绪
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => import("./main"));
} else {
    import("./main");
}
