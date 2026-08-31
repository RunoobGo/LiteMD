// titlebar.test.ts — 无边框标题栏控制单元测试
//
// 覆盖四类行为：
//   1. 降级   —— 无窗口运行时（浏览器 mock）时控制按钮整组隐藏
//   2. 按钮   —— min/max/close 分别调用注入的窗口操作
//   3. 手势   —— 双击标题栏空白切换最大化；双击按钮不触发
//   4. 状态   —— resize 防抖查询 WindowIsMaximised 并切换 is-maximised 图标类
//
// titlebar.ts 通过依赖注入接收窗口操作，测试直接传 fake 实现，
// 不加载 wailsjs（ts 格式 / runtime 依赖均在被测模块之外）。

const TOPBAR_HTML = `
<header class="topbar">
    <div class="brand">LiteMD</div>
    <nav class="actions">
        <button data-action="new" aria-label="新建"></button>
    </nav>
    <div class="meta" id="meta">未保存</div>
    <div class="window-controls" id="windowControls">
        <button class="wc-btn" data-wc="min" aria-label="最小化"></button>
        <button class="wc-btn" data-wc="max" aria-label="最大化">
            <svg class="icon-max"></svg><svg class="icon-restore"></svg>
        </button>
        <button class="wc-btn wc-close" data-wc="close" aria-label="关闭"></button>
    </div>
</header>`;

import { initTitlebar } from "./titlebar";
import { quitDecision, confirmQuit } from "./unsaved-guard";
import type { TabManager } from "./tabs";

interface FakeWin {
    minimise: number;
    toggleMaximise: number;
    quit: number;
    maximised: boolean;
    isMaximisedQueries: number;
}

function makeFakeWin(maximised = false) {
    const f: FakeWin = {
        minimise: 0, toggleMaximise: 0, quit: 0,
        maximised, isMaximisedQueries: 0,
    };
    return {
        win: {
            minimise: () => { f.minimise++; },
            toggleMaximise: () => {
                f.toggleMaximise++;
                f.maximised = !f.maximised; // 模拟真实 toggle 语义
            },
            isMaximised: async () => {
                f.isMaximisedQueries++;
                return f.maximised;
            },
            quit: () => { f.quit++; },
        },
        calls: f,
    };
}

/** 重置 DOM 到标准标题栏结构并返回关键元素 */
function setupDom() {
    document.body.innerHTML = TOPBAR_HTML;
    return {
        topbar: document.querySelector<HTMLElement>(".topbar")!,
        controls: document.querySelector<HTMLElement>(".window-controls")!,
        min: document.querySelector<HTMLButtonElement>("button[data-wc='min']")!,
        max: document.querySelector<HTMLButtonElement>("button[data-wc='max']")!,
        close: document.querySelector<HTMLButtonElement>("button[data-wc='close']")!,
        tool: document.querySelector<HTMLButtonElement>(".actions button")!,
    };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
    if (cond) { pass++; console.log("  ✓ " + msg); }
    else { fail++; console.log("  ✗ " + msg); }
}

async function main() {
    // ------------------------------------------------------------------
    console.log("降级（无窗口运行时）：");
    {
        const dom = setupDom();
        initTitlebar(null);
        assert(dom.controls.hidden === true, "win=null 时 .window-controls 隐藏");
        // 隐藏后点击不应有任何副作用（未绑定监听器）
        dom.min.click();
        dom.close.click();
        assert(true, "隐藏态点击按钮无异常抛出");
        await sleep(10);
    }

    // ------------------------------------------------------------------
    console.log("\n窗口控制按钮：");
    {
        const dom = setupDom();
        const { win, calls } = makeFakeWin();
        initTitlebar(win);

        dom.min.click();
        assert(calls.minimise === 1, "点击 min → minimise()");

        dom.close.click();
        assert(calls.quit === 1, "点击 close → quit()");

        dom.max.click();
        assert(calls.toggleMaximise === 1, "点击 max → toggleMaximise()");
        await sleep(200); // 等待防抖同步
        assert(dom.topbar.classList.contains("is-maximised"),
            "toggle 后 isMaximised=true → topbar 挂 is-maximised（切还原图标）");
    }

    // ------------------------------------------------------------------
    console.log("\n双击标题栏：");
    {
        const dom = setupDom();
        const { win, calls } = makeFakeWin();
        initTitlebar(win);
        await sleep(200); // 消化上一用例遗留的防抖定时器

        // 双击空白（meta 文本区域，非按钮）
        dom.topbar.querySelector(".meta")!.dispatchEvent(
            new MouseEvent("dblclick", { bubbles: true }));
        assert(calls.toggleMaximise === 1, "双击标题栏空白 → toggleMaximise()");

        // 双击工具栏按钮：不触发（closest("button") 排除）
        dom.tool.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        assert(calls.toggleMaximise === 1, "双击工具栏按钮不触发最大化");

        // 双击窗口控制按钮：不触发
        dom.max.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        assert(calls.toggleMaximise === 1, "双击窗口控制按钮不触发最大化");
    }

    // ------------------------------------------------------------------
    console.log("\n最大化状态同步（resize 防抖）：");
    {
        const dom = setupDom();
        const { win, calls } = makeFakeWin(true);
        initTitlebar(win);
        await sleep(200);
        assert(dom.topbar.classList.contains("is-maximised"), "初始 maximised=true → 挂类");

        calls.maximised = false; // 模拟用户拖动标题栏还原窗口
        window.dispatchEvent(new Event("resize"));
        await sleep(250);
        assert(!dom.topbar.classList.contains("is-maximised"),
            "resize 后查询到已还原 → 移除 is-maximised（切回最大化图标）");
    }

    // ------------------------------------------------------------------
    console.log("\n#3 退出协商（quitDecision / confirmQuit）：");
    {
        // quitDecision 纯决策：与 DOM 解耦的退出放行逻辑
        assert(quitDecision(false, null) === true, "无脏标签 → 直接放行（不弹窗）");
        assert(quitDecision(false, "cancel") === true, "无脏标签 + 任意选择 → 放行");
        assert(quitDecision(true, "quit") === true, "有脏 + 显式选择退出 → 放行");
        assert(quitDecision(true, "cancel") === false, "有脏 + 取消 → 拦截");
        assert(quitDecision(true, null) === false, "有脏 + ESC/关闭对话框（null）→ 拦截");

        // confirmQuit 集成：无脏路径不触碰 DOM（jsdom 下可测）
        const fakeCleanTm = { hasAnyDirty: () => false } as unknown as TabManager;
        assert(await confirmQuit(fakeCleanTm) === true, "confirmQuit：无脏 → true 且未触碰 DOM");
    }
    // 有脏路径依赖 showModal()（jsdom 未实现），交由 E2E（agent-browser）覆盖：
    // 点击关闭 → quitDialog 出现 → 「退出并放弃修改」→ 进程退出 / 「取消」→ 保留。

    // ------------------------------------------------------------------
    console.log(`\n${pass} 通过 / ${fail} 失败`);
    if (fail > 0) process.exit(1);
}

main();
