// toc.ts — Markdown 文档大纲（目录树）
//
// 设计要点：
//   1. 纯解析（parseToc / buildTocTree）与渲染（TocPanel）分离 —— 前者可在 node 下
//      直接单测，后者依赖 DOM。
//   2. 大纲只关心"哪些行是标题"，因此刻意不复用 marked：marked 是渲染器，
//      用它取行号需要 AST 反查 position，反而更绕且更慢。
//   3. 必须跳过围栏代码块与 YAML frontmatter —— 否则 shell 注释里的 `# 安装`
//      会被当成 H1，这是同类实现最常见的 bug。
//   4. TocPanel.update() 带内容签名短路：正文打字时不重建 DOM。

/** 大纲条目（树形，children 为其子标题） */
export interface TocEntry {
    /** 标题层级 1..6 */
    level: number;
    /** 清洗掉行内 Markdown 标记后的显示文本 */
    text: string;
    /** 源码行号（1-based，标题所在行） */
    line: number;
    children: TocEntry[];
}

/** 扁平条目，供 TocPanel 内部线性查找当前章节 */
interface FlatEntry extends TocEntry {
    /** 树中位置路径，如 "0.2.1"，用作折叠状态的稳定 key */
    path: string;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** ATX 标题：`#`~`######`，后跟空格或行尾（`#hashtag` 不算标题） */
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/** 围栏代码开关：``` 或 ~~~（允许最多 3 个前导空格 + 信息串） */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/**
 * Setext 下划线：`===` → H1，`---` → H2。
 * `-` 要求 2 个以上：单个 `-` 在 Markdown 里是合法列表项，
 * 只有 `---` 才同时具备"分隔线"与"Setext H2"两种可能，无法消歧时按分隔线处理。
 */
const SETEXT_RE = /^ {0,3}(=+|-{2,})[ \t]*$/;

/**
 * 解析 Markdown，返回扁平的标题列表（按出现顺序，未嵌套）。
 *
 * 处理规则：
 *   - 跳过 ``` / ~~~ 围栏内的所有内容（含 shell 注释里的 `#`）
 *   - 跳过文件开头的 YAML frontmatter 块
 *   - 同时支持 ATX（`# 标题`）与 Setext（`标题` + `===`/`---`）
 *
 * @param md Markdown 原文
 */
export function parseToc(md: string): TocEntry[] {
    const out: TocEntry[] = [];
    if (!md) return out;

    const lines = md.split(/\r?\n/);
    // 围栏状态：记录开启的围栏字符与长度（闭合需同字符且长度 >=）
    let fence: { ch: string; len: number } | null = null;
    // frontmatter 状态：仅在文件首行为 `---` 时进入，遇到 `---`/`...` 结束
    let inFrontmatter = lines.length > 0 && lines[0].trim() === "---";

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // ---- frontmatter ----
        if (inFrontmatter) {
            // 首行是开启符，从第二行起找结束符
            if (i > 0 && /^ {0,3}(---|\.\.\.)[ \t]*$/.test(line)) inFrontmatter = false;
            continue;
        }

        // ---- 围栏代码 ----
        const fm = line.match(FENCE_RE);
        if (fm) {
            const marker = fm[1];
            const ch = marker[0];
            const len = marker.length;
            if (!fence) {
                fence = { ch, len };
            } else if (ch === fence.ch && len >= fence.len) {
                fence = null;
            }
            continue;
        }
        if (fence) continue;

        // ---- Setext 标题（依赖上一行）----
        if (SETEXT_RE.test(line) && i > 0) {
            const prev = lines[i - 1];
            const prevTrim = prev.trim();
            // 上一行需为非空、且本身不是 ATX 标题 / 围栏 —— 否则是分隔线或嵌套场景
            if (prevTrim !== "" && !ATX_RE.test(prev) && !FENCE_RE.test(prev)) {
                out.push({
                    level: line.trim()[0] === "=" ? 1 : 2,
                    text: cleanHeading(prevTrim),
                    // 标题文本所在行才是跳转目标（下划线行本身无意义）
                    line: i, // lines[i-1] 的 1-based 行号
                    children: [],
                });
                continue;
            }
        }

        // ---- ATX 标题 ----
        const atx = line.match(ATX_RE);
        if (atx) {
            out.push({
                level: atx[1].length,
                text: cleanHeading(atx[2] ?? ""),
                line: i + 1,
                children: [],
            });
        }
    }

    return out;
}

/**
 * 把扁平标题列表按层级嵌套成树。
 *
 * 层级跳变（如 H2 直接跟 H4）时，按 Markdown 惯例补齐中间层级：
 * H4 会成为该 H2 的直接子节点，而不是制造不存在的 H3 占位节点。
 */
export function buildTocTree(flat: TocEntry[]): TocEntry[] {
    const roots: TocEntry[] = [];
    // 每层的"当前末节点"，用于 O(n) 挂载
    const stack: TocEntry[] = [];

    for (const item of flat) {
        const node: TocEntry = { ...item, children: [] };
        while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
        if (stack.length === 0) {
            roots.push(node);
        } else {
            stack[stack.length - 1].children.push(node);
        }
        stack.push(node);
    }
    return roots;
}

/** 清洗标题里的行内 Markdown，得到纯展示文本 */
function cleanHeading(raw: string): string {
    let s = raw;
    // ATX 前缀 / 闭合 # 序列
    s = s.replace(/^ {0,3}#{1,6}[ \t]+/, "");
    s = s.replace(/[ \t]+#+[ \t]*$/, "");
    // 图片、wiki 链接、普通链接（先长后短，避免 [[x]] 被 [x] 规则误吃）
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => (b || a).trim());
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    // 行内代码
    s = s.replace(/`+([^`]*)`+/g, "$1");
    // 强调 / 加粗 / 删除线
    s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
    s = s.replace(/(\*|_)(.*?)\1/g, "$2");
    s = s.replace(/~~(.*?)~~/g, "$1");
    // 裸 HTML 标签
    s = s.replace(/<[^>]+>/g, "");
    // 反斜杠转义
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1");
    return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

export interface TocPanelOptions {
    /** 点击大纲条目：参数为源码行号（1-based） */
    onSelect: (line: number) => void;
}

/**
 * 大纲面板：把 TocEntry 树渲染为可折叠的 DOM 树，支持"当前章节"高亮。
 *
 * 折叠状态按树中位置路径（如 "0.2"）记忆而非按标题文本 —— 编辑标题文字时
 * 路径不变，折叠状态因此不会因打字而丢失。
 */
export class TocPanel {
    private host: HTMLElement;
    private onSelect: (line: number) => void;
    private flat: FlatEntry[] = [];
    private collapsed = new Set<string>();
    private activeLine = -1;
    private lastSig: string | null = null;
    /** 每行渲染出的 DOM，供高亮时 O(1) 定位 */
    private rows = new Map<number, HTMLElement>();

    constructor(host: HTMLElement, opts: TocPanelOptions) {
        this.host = host;
        this.onSelect = opts.onSelect;
        // 事件委托：一个监听器覆盖所有条目，重建 DOM 时无需重新绑定
        this.host.addEventListener("click", (e) => this.onClick(e));
        // 键盘可达性（审查 🟡-9）：容器作为唯一 Tab 入口，焦点进入后
        // 转交给当前高亮行，行间用方向键漫游（见 onKeydown）。
        this.host.tabIndex = 0;
        this.host.addEventListener("focus", () => {
            const target = this.rows.get(this.activeLine) ?? this.visibleRows()[0];
            target?.focus();
        });
        this.host.addEventListener("keydown", (e) => this.onKeydown(e));
    }

    /** 用新的文档内容刷新大纲。content 为空/null 时渲染空状态。 */
    update(content: string | null): void {
        const tree = buildTocTree(parseToc(content ?? ""));
        this.assignPaths(tree, "");
        this.flat = flatten(tree);

        // 签名短路：正文打字不改变任何标题 → 跳过整棵 DOM 重建
        // 空状态文案也计入签名：无文档与「有内容但无标题」的 flat 都是空数组，
        // 若只看 flat，从空文档切到无标题文档会命中短路、文案停在「未打开文档」。
        const emptyKind = content && content.trim() ? "no-heading" : "no-doc";
        const sig = `${emptyKind}\n` + this.flat.map((e) => `${e.level}|${e.text}|${e.line}`).join("\n");
        if (sig === this.lastSig) {
            this.applyActive();
            return;
        }
        this.lastSig = sig;

        this.host.textContent = "";
        this.rows.clear();

        if (this.flat.length === 0) {
            const empty = document.createElement("p");
            empty.className = "toc-empty";
            empty.textContent = content && content.trim() ? "本文档暂无标题" : "未打开文档";
            this.host.appendChild(empty);
            this.activeLine = -1;
            return;
        }

        const list = document.createElement("ul");
        list.className = "toc-list";
        list.setAttribute("role", "tree");
        for (const node of tree) list.appendChild(this.renderNode(node));
        this.host.appendChild(list);
        this.applyActive();
    }

    /**
     * 高亮光标所在章节（取行号 <= cursorLine 的最后一个标题）。
     * 光标行未跨章节时不做任何 DOM 操作。
     */
    setActiveLine(cursorLine: number): void {
        let target = -1;
        for (const e of this.flat) {
            if (e.line <= cursorLine) target = e.line;
            else break;
        }
        if (target === this.activeLine) return;
        this.activeLine = target;
        this.applyActive();
    }

    /** 清空面板（无活动标签时调用） */
    clear(): void {
        this.update(null);
    }

    // ---- 内部 ----

    private assignPaths(nodes: TocEntry[], prefix: string): void {
        nodes.forEach((n, i) => {
            const path = prefix ? `${prefix}.${i}` : `${i}`;
            (n as FlatEntry).path = path;
            this.assignPaths(n.children, path);
        });
    }

    private renderNode(node: TocEntry): HTMLElement {
        const li = document.createElement("li");
        li.className = "toc-node";

        const row = document.createElement("div");
        row.className = "toc-row";
        row.dataset.line = String(node.line);
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", String(node.level));
        row.tabIndex = -1; // roving：焦点由方向键管理，不参与 Tab 序
        row.title = node.text || "无标题";
        // 缩进用 CSS 变量驱动，避免在 JS 里拼 style 字符串（也便于主题统一调整）
        row.style.setProperty("--toc-level", String(node.level - 1));

        const hasChildren = node.children.length > 0;
        const twisty = document.createElement("button");
        twisty.className = "toc-twisty" + (hasChildren ? "" : " leaf");
        twisty.type = "button";
        if (hasChildren) {
            const collapsed = this.collapsed.has((node as FlatEntry).path);
            twisty.dataset.path = (node as FlatEntry).path;
            twisty.dataset.action = "toc-toggle";
            twisty.textContent = collapsed ? "▸" : "▾";
            twisty.setAttribute("aria-label", collapsed ? "展开" : "折叠");
            twisty.setAttribute("aria-expanded", String(!collapsed));
        } else {
            twisty.tabIndex = -1;
            twisty.setAttribute("aria-hidden", "true");
        }
        row.appendChild(twisty);

        const text = document.createElement("span");
        text.className = "toc-text";
        // textContent 而非 innerHTML：标题内容来自用户文档，杜绝 XSS
        text.textContent = node.text || "无标题";
        row.appendChild(text);

        li.appendChild(row);
        this.rows.set(node.line, row);

        if (hasChildren) {
            const ul = document.createElement("ul");
            ul.className = "toc-list";
            ul.setAttribute("role", "group");
            if (this.collapsed.has((node as FlatEntry).path)) ul.hidden = true;
            for (const c of node.children) ul.appendChild(this.renderNode(c));
            li.appendChild(ul);
        }
        return li;
    }

    private onClick(e: MouseEvent): void {
        const target = e.target as HTMLElement;
        const row = target.closest<HTMLElement>(".toc-row");
        if (!row) return;

        // 折叠箭头：切换子树显隐，不触发跳转
        if (target.dataset.action === "toc-toggle") {
            e.stopPropagation();
            this.toggleCollapse(row);
            return;
        }

        const line = Number(row.dataset.line);
        if (Number.isFinite(line) && line > 0) this.onSelect(line);
    }

    /**
     * 键盘导航（审查 🟡-9）：↑/↓ 在可见行间移动焦点并跳转，
     * Home/End 跳首尾，← 折叠 / → 展开，Enter/Space 跳转当前行。
     */
    private onKeydown(e: KeyboardEvent): void {
        const row = (e.target as HTMLElement).closest<HTMLElement>(".toc-row");
        if (!row) return;
        const visible = this.visibleRows();
        const idx = visible.indexOf(row);
        if (idx < 0) return;
        const move = (target: HTMLElement) => {
            target.focus();
            const line = Number(target.dataset.line);
            if (Number.isFinite(line) && line > 0) {
                this.onSelect(line);
                // onSelect 会跳转编辑器（revealLine → view.focus 抢焦点）。
                // 键盘漫游语义下焦点应留在 TOC，跳转完成后抢回（点击/Enter 才移交焦点）。
                target.focus();
            }
        };
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                if (idx < visible.length - 1) move(visible[idx + 1]);
                break;
            case "ArrowUp":
                e.preventDefault();
                if (idx > 0) move(visible[idx - 1]);
                break;
            case "Home":
                e.preventDefault();
                if (visible.length) move(visible[0]);
                break;
            case "End":
                e.preventDefault();
                if (visible.length) move(visible[visible.length - 1]);
                break;
            case "ArrowLeft":
                // 已展开的节点 → 折叠（叶子节点忽略）
                e.preventDefault();
                if (this.rowTwisty(row)?.getAttribute("aria-expanded") === "true") {
                    this.toggleCollapse(row);
                }
                break;
            case "ArrowRight":
                // 已折叠的节点 → 展开（叶子节点忽略）
                e.preventDefault();
                if (this.rowTwisty(row)?.getAttribute("aria-expanded") === "false") {
                    this.toggleCollapse(row);
                }
                break;
            case "Enter":
            case " ":
                e.preventDefault();
                {
                    const line = Number(row.dataset.line);
                    if (Number.isFinite(line) && line > 0) this.onSelect(line);
                }
                break;
        }
    }

    /** 行内的折叠箭头（无子节点的行返回 null） */
    private rowTwisty(row: HTMLElement): HTMLElement | null {
        return row.querySelector<HTMLElement>(".toc-twisty[data-action='toc-toggle']");
    }

    /** 当前可见（未随折叠子树隐藏）的行，按文档顺序 */
    private visibleRows(): HTMLElement[] {
        const out: HTMLElement[] = [];
        // 纯 DOM 判定（不依赖布局，jsdom 下同样成立）：处于 ul[hidden]
        // 折叠子树内的行跳过
        this.host.querySelectorAll<HTMLElement>(".toc-row").forEach((el) => {
            if (!el.closest("ul[hidden]")) out.push(el);
        });
        return out;
    }

    /** 切换指定行的折叠状态（点击 twisty 与键盘 ←/→ 共用） */
    private toggleCollapse(row: HTMLElement): void {
        const twisty = this.rowTwisty(row);
        if (!twisty) return;
        const path = twisty.dataset.path;
        if (!path) return;
        const ul = row.parentElement?.querySelector<HTMLElement>(":scope > ul");
        if (this.collapsed.has(path)) {
            this.collapsed.delete(path);
            twisty.textContent = "▾";
            twisty.setAttribute("aria-expanded", "true");
            twisty.setAttribute("aria-label", "折叠");
            if (ul) ul.hidden = false;
        } else {
            this.collapsed.add(path);
            twisty.textContent = "▸";
            twisty.setAttribute("aria-expanded", "false");
            twisty.setAttribute("aria-label", "展开");
            if (ul) ul.hidden = true;
        }
    }

    private applyActive(): void {
        for (const [line, row] of this.rows) {
            const on = line === this.activeLine;
            row.classList.toggle("active", on);
            if (on) row.setAttribute("aria-selected", "true");
            else row.removeAttribute("aria-selected");
        }
        // 高亮项滚入视野（仅在其不可见时，避免打断用户手动滚动）
        if (this.activeLine > 0) {
            const row = this.rows.get(this.activeLine);
            const box = this.host;
            if (row && typeof row.scrollIntoView === "function") {
                const r = row.getBoundingClientRect();
                const b = box.getBoundingClientRect();
                if (r.top < b.top || r.bottom > b.bottom) {
                    row.scrollIntoView({ block: "nearest" });
                }
            }
        }
    }
}

function flatten(nodes: TocEntry[]): FlatEntry[] {
    const out: FlatEntry[] = [];
    const walk = (list: TocEntry[]) => {
        for (const n of list) {
            out.push(n as FlatEntry);
            walk(n.children);
        }
    };
    walk(nodes);
    return out;
}
