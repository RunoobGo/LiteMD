// editor.ts — CodeMirror 6 编辑器封装
//
// 关键点：
//   - 切换 tab 时由 setContent(value) 覆盖内容（不通过 dispatch，避免污染 undo history）
//   - 用户输入时通过 onUpdate 回调 → TabManager.syncLiveContent
//   - 光标移动时通过 onCursorChange 回调 → 状态栏显示行列位置
//   - 主题：跟随 SetConfig 配置（dark/light，未配置则用 one-dark 默认）

import { EditorState, Compartment, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { autocompletion, completionKeymap, startCompletion } from "@codemirror/autocomplete";
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export type EditorChangeListener = (content: string) => void;
/** 光标位置变化回调：(行号从 1 开始, 列号从 1 开始) */
export type CursorChangeListener = (line: number, col: number) => void;

export interface LiteMDTheme {
    base: "light" | "dark";
}

export type ImageDropHandler = (file: File, clientX: number, clientY: number) => void | Promise<void>;

const mdHighlight = HighlightStyle.define([
    { tag: t.heading1, color: "var(--md-h1)", fontWeight: "700", fontSize: "1.5em" },
    { tag: t.heading2, color: "var(--md-h2)", fontWeight: "600", fontSize: "1.3em" },
    { tag: t.heading3, color: "var(--md-h3)", fontWeight: "600", fontSize: "1.15em" },
    { tag: t.heading, color: "var(--md-heading)" },
    { tag: t.link, color: "var(--md-link)", textDecoration: "underline" },
    { tag: t.url, color: "var(--md-link)" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.monospace, color: "var(--md-code)", fontFamily: "var(--font-mono)" },
    { tag: t.quote, color: "var(--md-quote)", fontStyle: "italic" },
    { tag: t.list, color: "var(--md-list)" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.meta, color: "var(--md-meta)" },
    { tag: t.processingInstruction, color: "var(--md-meta)" },
    { tag: t.contentSeparator, color: "var(--md-meta)" },
]);

export class MarkdownEditor {
    private view: EditorView;
    private onChange: EditorChangeListener;
    private onCursorChange: CursorChangeListener | null;
    private themeCompartment = new Compartment();
    private baseThemeCompartment = new Compartment();
    // P0-4：history 放进 Compartment，切 tab 时整体换新实例以清空 undo 栈
    private historyCompartment = new Compartment();
    private imageDropHandler: ImageDropHandler | null = null;

    constructor(host: HTMLElement, initialContent: string, onChange: EditorChangeListener, theme: LiteMDTheme = { base: "dark" }, onCursorChange?: CursorChangeListener) {
        this.onChange = onChange;
        this.onCursorChange = onCursorChange ?? null;
        const extensions = [
            lineNumbers(),
            foldGutter(),
            this.historyCompartment.of(history()),
            indentOnInput(),
            indentUnit.of("    "),
            bracketMatching(),
            highlightActiveLine(),
            // P1-1：search() 提供 searchState field，searchKeymap 的
            // openSearchPanel/closeSearchPanel 依赖它——漏注册时 Ctrl+F 是空操作
            search(),
            highlightSelectionMatches(),
            autocompletion(),
            keymap.of([
                ...defaultKeymap,
                ...historyKeymap,
                ...searchKeymap,
                ...completionKeymap,
                indentWithTab,
                { key: "Mod-Space", run: startCompletion },
            ]),
            EditorView.lineWrapping,
            // 不再 import language-data 全部语言（节省 ~200KB）；
            // code block 仍是 ``` 包裹的纯文本，CodeMirror 不解析内部语法
            markdown({ base: markdownLanguage }),
            syntaxHighlighting(mdHighlight, { fallback: true }),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            this.themeCompartment.of(theme.base === "dark" ? oneDark : []),
            this.baseThemeCompartment.of(this.buildBaseTheme(theme.base)),
            EditorView.updateListener.of((u) => {
                if (u.docChanged) {
                    this.onChange(u.state.doc.toString());
                }
                // 光标位置变化或内容变化时，回调最新行列位置（供状态栏显示）
                if (this.onCursorChange && (u.selectionSet || u.docChanged)) {
                    const head = u.state.selection.main.head;
                    const lineObj = u.state.doc.lineAt(head);
                    this.onCursorChange(lineObj.number, head - lineObj.from + 1);
                }
            }),
            // 图片拖入：阻止默认 + 调用回调
            EditorView.domEventHandlers({
                drop: (e, _view) => {
                    if (!e.dataTransfer) return;
                    const files = Array.from(e.dataTransfer.files);
                    const images = files.filter((f) => f.type.startsWith("image/"));
                    if (!images.length) return;
                    e.preventDefault();
                    for (const img of images) {
                        if (this.imageDropHandler) {
                            this.imageDropHandler(img, e.clientX, e.clientY);
                        }
                    }
                },
                paste: (e, _view) => {
                    if (!e.clipboardData) return;
                    const items = Array.from(e.clipboardData.items);
                    const images = items.filter((it) => it.kind === "file" && it.type.startsWith("image/"));
                    if (!images.length) return;
                    e.preventDefault();
                    for (const it of images) {
                        const file = it.getAsFile();
                        if (!file) continue;
                        if (this.imageDropHandler) {
                            this.imageDropHandler(file, 0, 0);
                        }
                    }
                },
            }),
        ];

        const state = EditorState.create({
            doc: initialContent,
            extensions,
        });

        this.view = new EditorView({ state, parent: host });
        // 触发一次初始回调（让 TabManager 同步 baseline）
        if (initialContent) this.onChange(initialContent);
    }

    /** 注册图片拖入回调 */
    onImageDrop(handler: ImageDropHandler) {
        this.imageDropHandler = handler;
    }

    /**
     * 替换文档内容（用于切换 tab 时）。
     *
     * 双重防护（P0-4）：
     *  1. `Transaction.addToHistory.of(false)`：切换本身不进 undo 历史；
     *  2. `historyCompartment.reconfigure(history())`：换一个全新的 history
     *     实例，**清空整个 undo 栈**。仅靠第 1 条不够——栈里还留着上一个
     *     文件的编辑记录，切到 B 后按 Ctrl+Z 会把 A 的变更逆放回 B 的文档，
     *     触发保存后即跨文件数据污染。CodeMirror 无法序列化 history 状态，
     *     「换新实例清栈」是切换场景下唯一正确的隔离方式（代价：切回来的
     *     tab 不保留之前的 undo 历史，属可接受取舍）。
     */
    setContent(content: string) {
        if (this.view.state.doc.toString() === content) return;
        this.view.dispatch({
            changes: { from: 0, to: this.view.state.doc.length, insert: content },
            annotations: Transaction.addToHistory.of(false),
            selection: { anchor: 0 },
            scrollIntoView: true,
            effects: this.historyCompartment.reconfigure(history()),
        });
    }

    /** 获取当前内容（O(1)） */
    getContent(): string {
        return this.view.state.doc.toString();
    }

    /** 获取主光标位置 {line, col}（行号、列号均从 1 开始） */
    getCursorPos(): { line: number; col: number } {
        const head = this.view.state.selection.main.head;
        const lineObj = this.view.state.doc.lineAt(head);
        return { line: lineObj.number, col: head - lineObj.from + 1 };
    }

    /**
     * 跳转并聚焦到指定行：滚动到视口顶部 + 光标落到行首 + 抢焦点。
     *
     * 与 scrollToLine 的分工：后者只滚容器、不动选区、不抢焦点
     * （同步滚动链路用，抢焦点会打断用户正在另一侧的输入）。
     */
    revealLine(line: number) {
        const lines = this.view.state.doc.lines;
        const n = Math.min(Math.max(1, line), lines);
        const lineObj = this.view.state.doc.line(n);
        this.view.dispatch({
            selection: { anchor: lineObj.from },
            effects: EditorView.scrollIntoView(lineObj.from, { y: "start" }),
        });
        this.view.focus();
    }

    /**
     * 在光标处插入文本（图片拖入/粘贴用），光标移到插入内容之后并滚入视野。
     * 旧版用 setContent 拼接文档末尾：内容跑到尾部、光标重置到文档首（审查 🟡-2）。
     */
    insertAtCursor(text: string): void {
        const head = this.view.state.selection.main.head;
        this.view.dispatch({
            changes: { from: head, insert: text },
            selection: { anchor: head + text.length },
            scrollIntoView: true,
        });
        this.view.focus();
    }

    /** 光标定位到指定行列（1-based），供恢复 tab 记忆的光标位置 */
    setCursorPos(line: number, col: number): void {
        const lines = this.view.state.doc.lines;
        const n = Math.min(Math.max(1, line), lines);
        const lineObj = this.view.state.doc.line(n);
        const anchor = Math.min(lineObj.from + Math.max(0, col - 1), lineObj.to);
        this.view.dispatch({ selection: { anchor } });
    }

    /** 编辑器滚动位置（tab 切换记忆用） */
    getScrollTop(): number {
        return this.view.scrollDOM.scrollTop;
    }

    setScrollTop(top: number): void {
        this.view.scrollDOM.scrollTop = top;
    }

    /** 切主题 */
    setTheme(theme: LiteMDTheme) {
        this.view.dispatch({
            effects: [
                this.themeCompartment.reconfigure(theme.base === "dark" ? oneDark : []),
                // 基础主题一并重建：dark 标志（影响选区/面板绘制）需与新主题一致
                this.baseThemeCompartment.reconfigure(this.buildBaseTheme(theme.base)),
            ],
        });
    }

    /** 焦点到编辑器 */
    focus() {
        this.view.focus();
    }

    /** 编辑器滚动容器（同步滚动监听用） */
    getScrollDOM(): HTMLElement {
        return this.view.scrollDOM;
    }

    /** 视口顶部当前对应的文档行号（1-based，同步滚动用） */
    getTopLine(): number {
        const block = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop);
        return this.view.state.doc.lineAt(block.from).number;
    }

    /** 滚动到指定行（该行顶部对齐视口顶，1-based，同步滚动用） */
    scrollToLine(line: number) {
        const lines = this.view.state.doc.lines;
        const n = Math.min(Math.max(1, line), lines);
        const block = this.view.lineBlockAt(this.view.state.doc.line(n).from);
        this.view.scrollDOM.scrollTop = block.top;
    }

    private buildBaseTheme(base: "light" | "dark") {
        // backgroundColor/color 引用 CSS 变量并置于主题扩展之后，
        // 覆盖 oneDark 的硬编码底色，使编辑器跟随全局暗/亮主题切换
        return EditorView.theme({
            "&": { height: "100%", fontSize: "var(--md-fontsize, 14px)", backgroundColor: "var(--bg-0)", color: "var(--fg-1)" },
            ".cm-scroller": { fontFamily: "var(--font-mono)" },
            ".cm-gutters": { backgroundColor: "var(--md-gutter-bg)", color: "var(--md-gutter-fg)", border: "none" },
            ".cm-activeLineGutter": { backgroundColor: "var(--md-gutter-active-bg)" },
            ".cm-content": { caretColor: "var(--md-caret)" },
            "&.cm-focused .cm-cursor": { borderLeftColor: "var(--md-caret)" },
        }, { dark: base === "dark" });
    }
}
