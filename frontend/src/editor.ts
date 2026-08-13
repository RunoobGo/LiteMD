// editor.ts — CodeMirror 6 编辑器封装
//
// 关键点：
//   - 切换 tab 时由 setContent(value) 覆盖内容（不通过 dispatch，避免污染 undo history）
//   - 用户输入时通过 onUpdate 回调 → TabManager.syncLiveContent
//   - 主题：跟随 SetConfig 配置（dark/light，未配置则用 one-dark 默认）

import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, completionKeymap, startCompletion } from "@codemirror/autocomplete";
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export type EditorChangeListener = (content: string) => void;

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
    private themeCompartment = new Compartment();
    private imageDropHandler: ImageDropHandler | null = null;

    constructor(host: HTMLElement, initialContent: string, onChange: EditorChangeListener, theme: LiteMDTheme = { base: "dark" }) {
        this.onChange = onChange;
        const baseThemeExt = this.buildBaseTheme(theme.base);
        const extensions = [
            lineNumbers(),
            foldGutter(),
            history(),
            indentOnInput(),
            indentUnit.of("    "),
            bracketMatching(),
            highlightActiveLine(),
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
            baseThemeExt,
            EditorView.updateListener.of((u) => {
                if (u.docChanged) {
                    this.onChange(u.state.doc.toString());
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

    /** 替换文档内容（用于切换 tab 时）—— 通过 toString + update 模式，避免进 undo 历史 */
    setContent(content: string) {
        if (this.view.state.doc.toString() === content) return;
        this.view.dispatch({
            changes: { from: 0, to: this.view.state.doc.length, insert: content },
        });
    }

    /** 获取当前内容（O(1)） */
    getContent(): string {
        return this.view.state.doc.toString();
    }

    /** 切主题 */
    setTheme(theme: LiteMDTheme) {
        this.view.dispatch({
            effects: this.themeCompartment.reconfigure(theme.base === "dark" ? oneDark : []),
        });
    }

    /** 焦点到编辑器 */
    focus() {
        this.view.focus();
    }

    /** 销毁 */
    destroy() {
        this.view.destroy();
    }

    private buildBaseTheme(base: "light" | "dark") {
        return EditorView.theme({
            "&": { height: "100%", fontSize: "var(--md-fontsize, 14px)" },
            ".cm-scroller": { fontFamily: "var(--font-mono)" },
            ".cm-gutters": { backgroundColor: "var(--md-gutter-bg)", color: "var(--md-gutter-fg)" },
            ".cm-activeLineGutter": { backgroundColor: "var(--md-gutter-active-bg)" },
            ".cm-content": { caretColor: "var(--md-caret)" },
            "&.cm-focused .cm-cursor": { borderLeftColor: "var(--md-caret)" },
        }, { dark: base === "dark" });
    }
}
