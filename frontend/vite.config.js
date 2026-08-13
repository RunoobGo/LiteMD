const { resolve } = require("path");

/** @type {import('vite').UserConfig} */
module.exports = {
    // 双入口：
    //   - index.html : 生产模式（嵌入 Wails）
    //   - dev.html   : 浏览器/E2E 模式（mocks 注入 window.go）
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, "index.html"),
                dev: resolve(__dirname, "dev.html"),
            },
        },
    },
    server: {
        host: "127.0.0.1",
        port: 5173,
        strictPort: true,
    },
};
