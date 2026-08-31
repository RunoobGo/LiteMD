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
}

let _nextId = 1;
const genId = () => `tab-${Date.now()}-${_nextId++}`;

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

    /** 从文件路径打开一个新标签 */
    openTab(path: string, content: string): Tab {
        // 路径去重：已经打开则激活它
        for (const t of this.tabs.values()) {
            if (t.path === path) {
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
    replaceTabContent(id: string, payload: { path: string; content: string }): Tab | null {
        const t = this.tabs.get(id);
        if (!t) return null;
        t.path = payload.path;
        t.title = payload.path.split(/[\\/]/).pop() || payload.path;
        t.baseline = payload.content;
        t.liveContent = payload.content;
        t.dirty = false;
        t.diskMtime = Date.now() / 1000;
        t.frontmatter = null;
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
