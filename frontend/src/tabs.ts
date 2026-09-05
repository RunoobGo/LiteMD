// tabs.ts — 多标签状态管理
//
// 设计要点：
//   - 一个 tab 对应一个打开的缓冲区（可能是磁盘文件，也可能是未保存的新文件）
//   - dirty 标志位独立存在，与"是否已保存到磁盘"完全解耦（in-memory 改动即视为脏）
//   - activeId 永远是当前显示在编辑器里的标签 id
//   - liveContent 跟踪 textarea 的实时内容（用户输入会持续更新）
//   - baseline 是最近一次"干净状态"（保存或打开时的内容），用于 dirty 比较

export interface Tab {
    id: string;          // 内部唯一 id
    title: string;       // 标签标题（文件名或 "Untitled"）
    path: string;        // 磁盘路径，未保存时为空串
    baseline: string;    // 最近保存/打开时的内容（用于 dirty 比较）
    liveContent: string; // textarea 实时内容（用于切换时恢复）
    dirty: boolean;      // liveContent !== baseline
    diskMtime?: number;  // 已保存时的磁盘 mtime
    frontmatter: Record<string, string> | null; // 解析自 YAML；非 null 即存在
    /** 切走时记忆的光标位置（审查 🟡-2：切回时恢复） */
    cursor?: { line: number; col: number };
    /** 切走时记忆的编辑器滚动位置 */
    scrollTop?: number;
}

let _nextId = 1;
const genId = () => `tab-${Date.now()}-${_nextId++}`;

/**
 * 文件系统是否大小写不敏感（审查 Y2）。
 *
 * Windows NTFS 与 macOS APFS（默认）不区分大小写，`/notes/TODO.md` 与
 * `/notes/todo.md` 是同一个文件；Linux ext4 区分大小写，它们是两个文件。
 * 判定错了会有两种后果：在 Linux 上误合并两个不同文件（内容互相覆盖），
 * 或在 Win/mac 上把同一文件开成两个标签（保存时互相覆盖）。
 */
// 惰性求值而非模块级常量：一是页面加载早期判定更容易受嵌入环境影响，
// 二是便于单测直接改写 navigator.platform 覆盖两条分支。
// 读取开销可忽略（每次比较一次字符串包含判断）。
function detectCaseInsensitiveFs(): boolean {
    if (typeof navigator === "undefined") return false;
    // userAgentData.platform 是现代写法，navigator.platform 是兼容回退
    const p = String(
        (navigator as any)?.userAgentData?.platform ?? navigator.platform ?? ""
    ).toLowerCase();
    return p.includes("win") || p.includes("mac");
}

/**
 * 路径比较键：只用于判断"是不是同一个文件"，**绝不用于展示**。
 *
 * 归一化内容：反斜杠统一为正斜杠、百分号解码（前端拿到的 href 可能是
 * `%E6%96%87.md` 形态）、折叠连续斜杠；大小写不敏感的卷上再转小写。
 *
 * 注意这里**不**把结果写回 tab.path —— 状态栏 / 标签页 / 另存为对话框
 * 都应当显示磁盘上的真实大小写，归一化只发生在比较处。
 */
export function pathCompareKey(p: string): string {
    if (!p) return "";
    let s = p.replace(/\\/g, "/");
    try {
        s = decodeURI(s);
    } catch {
        // 百分号编码损坏（如孤立的 %zz）时保持原文，交由下游 Resolve 报错
    }
    s = s.replace(/\/{2,}/g, "/");
    return detectCaseInsensitiveFs() ? s.toLowerCase() : s;
}

export class TabManager {
    tabs = new Map<string, Tab>();
    order: string[] = []; // 显示顺序
    activeId: string | null = null;

    constructor(private onChange: () => void) {}

    private notify() { this.onChange(); }

    /** 创建一个空标签 */
    newTab(): Tab {
        const id = genId();
        const tab: Tab = {
            id,
            title: `Untitled-${this.countUntitled() + 1}.md`,
            path: "",
            baseline: "",
            liveContent: "",
            dirty: false,
            frontmatter: null,
        };
        this.tabs.set(id, tab);
        this.order.push(id);
        this.activate(id);
        return tab;
    }

    /** 从文件路径打开一个新标签；mtime 为磁盘真实 mtime（P0-5 外部修改检测记账） */
    openTab(path: string, content: string, mtime?: number): Tab {
        // 路径去重：已经打开则激活它（Y2：按比较键匹配，兼容大小写不敏感卷
        // 与 % 编码形态；tab.path 本身保持原样用于展示）
        const key = pathCompareKey(path);
        for (const t of this.tabs.values()) {
            if (pathCompareKey(t.path) === key) {
                this.activate(t.id);
                return t;
            }
        }
        const id = genId();
        const fileName = path.split(/[\\/]/).pop() || path;
        const tab: Tab = {
            id,
            title: fileName,
            path,
            baseline: content,
            liveContent: content,
            dirty: false,
            diskMtime: mtime,
            frontmatter: null,
        };
        this.tabs.set(id, tab);
        this.order.push(id);
        this.activate(id);
        return tab;
    }

    /**
     * 就地替换指定标签的内容与元数据（保持 id/order/activeId 不变），
     * 用于"在空新建页上打开文件"——避免出现"新 tab + 旧空 tab"两个标签。
     * 调用方需自行保证该标签是"未保存且为空"的安全覆盖目标。
     */
    replaceTabContent(id: string, payload: { path: string; content: string; modified?: number }): Tab | null {
        const t = this.tabs.get(id);
        if (!t) return null;
        t.path = payload.path;
        t.title = payload.path.split(/[\\/]/).pop() || payload.path;
        t.baseline = payload.content;
        t.liveContent = payload.content;
        t.dirty = false;
        // P0-5：记账磁盘真实 mtime（旧版用 Date.now() 伪造，检测必然失真）
        t.diskMtime = payload.modified;
        t.frontmatter = null;
        // 内容整体被替换：旧的光标/滚动记忆失效，清空避免恢复到错误位置
        t.cursor = undefined;
        t.scrollTop = undefined;
        this.activeId = id;
        this.notify();
        return t;
    }

    /** 切换激活标签 */
    activate(id: string) {
        if (this.tabs.has(id)) {
            this.activeId = id;
            this.notify();
        }
    }

    /** 关闭标签，传入 force=true 跳过未保存检查 */
    closeTab(id: string, force = false): { closed: boolean; reason?: string } {
        const t = this.tabs.get(id);
        if (!t) return { closed: false, reason: "not found" };
        if (t.dirty && !force) {
            return { closed: false, reason: "dirty" };
        }
        this.tabs.delete(id);
        const idx = this.order.indexOf(id);
        if (idx >= 0) this.order.splice(idx, 1);
        if (this.activeId === id) {
            if (this.order.length === 0) {
                this.activeId = null;
            } else {
                const next = this.order[Math.min(idx, this.order.length - 1)];
                this.activeId = next;
            }
        }
        this.notify();
        return { closed: true };
    }

    /** 同步实时内容（input 事件触发），自动更新 dirty 标志位 */
    syncLiveContent(id: string, content: string) {
        const t = this.tabs.get(id);
        if (!t) return;
        if (t.liveContent === content) return;
        t.liveContent = content;
        const wasDirty = t.dirty;
        t.dirty = t.liveContent !== t.baseline;
        if (t.dirty !== wasDirty) this.notify();
    }

    /** 重置基线（保存成功后调用）。
     *
     * #2 修复：不再用保存快照回写 liveContent。保存是异步 IO，await
     * 窗口期内用户继续输入已由 syncLiveContent 写入 liveContent；旧版
     * 在此覆盖为旧快照，导致保存瞬间敲下的字符凭空消失。liveContent
     * 以编辑器为唯一事实源，dirty 由 liveContent 与新 baseline 比较
     * 自然得出：保存期间无新输入 → 相等 → 干净；有新输入 → 保持脏。 */
    updateContentBaseline(id: string, content: string, path: string, mtime?: number) {
        const t = this.tabs.get(id);
        if (!t) return;
        t.baseline = content;
        t.dirty = t.liveContent !== t.baseline;
        t.path = path || t.path;
        t.diskMtime = mtime;
        if (path) {
            t.title = path.split(/[\\/]/).pop() || path;
        }
        this.notify();
    }

    /** 强制从 textarea 写入实时内容（不进 dirty 计算），用于 close 后重开恢复 */
    setLiveContent(id: string, content: string) {
        const t = this.tabs.get(id);
        if (!t) return;
        t.liveContent = content;
    }

    get active(): Tab | null {
        return this.activeId ? this.tabs.get(this.activeId) ?? null : null;
    }

    get(id: string): Tab | undefined {
        return this.tabs.get(id);
    }

    /** 审计 R2-F17：按 path 反查 tab（替代 id 复用检查，path 跨 IO
     *  稳定）。未找到或空 path 返回 null。 */
    findByPath(path: string): Tab | null {
        if (!path) return null;
        // Y2：与 openTab 同一口径，按比较键匹配
        const key = pathCompareKey(path);
        for (const t of this.tabs.values()) {
            if (pathCompareKey(t.path) === key) return t;
        }
        return null;
    }

    hasAnyDirty(): boolean {
        for (const t of this.tabs.values()) if (t.dirty) return true;
        return false;
    }

    private countUntitled(): number {
        let n = 0;
        for (const t of this.tabs.values()) if (!t.path) n++;
        return n;
    }
}
