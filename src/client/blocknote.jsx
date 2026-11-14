import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
// 编辑器自带的多语言词典：不传就全是英文（斜杠菜单、气泡工具条、占位符都是）。
import { zh } from '@blocknote/core/locales';
// CSS 走 text loader 内联（构建时把 @import 递归展开）：DSH 不保证宿主能加载插件的独立样式表。
import mantineCss from '@blocknote/mantine/style.css';

/**
 * markdown → BlockNote → markdown 的桥。
 * 正文永远以 md 为准：进来先 parse，出去用 blocksToMarkdownLossy，块级 JSON 只留在内存里。
 *
 * `blocks` 有值且与当前文件版本一致时（宿主按 mtime 校验过），直接拿它铺进编辑器，
 * 省掉一次整篇 markdown 解析——大文档打开能明显快一截。块 JSON 本身只缓存进 sqlite。
 *
 * `onUpload` 有值时，编辑器里粘贴/拖入的图片会交给它上传（七牛或本地 `_assets/`），
 * 返回可直接放进 markdown 的 URL。
 */
export function MarkdownEditor({
  markdown, blocks, notes = [], onChange, onReady, onUpload, onNoteClick,
  onSelectionChange, theme = 'light', readOnly = false,
}) {
  const [ready, setReady] = useState(false);
  const lastLoadedRef = useRef(null);
  const uploadRef = useRef(onUpload);
  uploadRef.current = onUpload;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const pinClickRef = useRef(onNoteClick);
  pinClickRef.current = onNoteClick;
  const selectionRef = useRef(onSelectionChange);
  selectionRef.current = onSelectionChange;

  // 笔记高亮 + 行内评论气泡。用 props.decorations 现算而不是塞插件 state：
  // 笔记数量通常是几十条，每次事务重算一遍比维护增量映射稳。
  const notePlugin = useMemo(() => new Plugin({
    key: new PluginKey('rag-notes'),
    props: {
      decorations(state) {
        try {
          return buildNoteDecorations(state, notesRef.current, (id) => pinClickRef.current?.(id));
        } catch (error) {
          console.warn('[dsh-rag] 笔记高亮渲染失败', error);
          return null;
        }
      },
      handleDOMEvents: {
        mouseup: () => { selectionRef.current?.(editorRef.current); return false; },
        keyup: () => { selectionRef.current?.(editorRef.current); return false; },
      },
    },
  }), []);
  const editorRef = useRef(null);

  const options = useMemo(() => ({
    // 词典必须在建编辑器时给：BlockNoteView 没有 dictionary 这个 prop，视图的斜杠菜单读的是编辑器实例上的词典。
    dictionary: zh,
    // 默认关闭 emoji 词典（构建时已 stub），图片走宿主上传。
    uploadFile: async (file) => {
      const handler = uploadRef.current;
      if (!handler) throw new Error('当前知识库不支持上传附件');
      return handler(file);
    },
    // BlockNote 0.57 的扩展是工厂函数：() => Extension。prosemirrorPlugins 挂进去即可参与渲染。
    extensions: [() => ({ key: 'rag-notes', prosemirrorPlugins: [notePlugin] })],
  }), []);
  const editor = useCreateBlockNote(options);
  editorRef.current = editor;

  // onReady 常常是内联箭头函数，每次 render 都是新引用。放进 ref，effect 就不会因为父组件重渲染
  // 而重跑（重跑会触发卸载回调，把宿主手里的编辑器清掉）。
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  useEffect(() => {
    if (!editor) return;
    // 回声：用户打字 → onChange 把 md 写回 state → 又回到这里。内容相同就不重建块，
    // 否则每敲一个字都会重解析整篇、光标被重置。
    if (markdown === lastLoadedRef.current) return;
    const cached = Array.isArray(blocksRef.current) ? blocksRef.current : null;
    let next = null;
    if (cached && cached.length > 0) {
      next = cached;
    } else {
      try {
        next = editor.tryParseMarkdownToBlocks(markdown ?? '');
      } catch (error) {
        console.warn('[dsh-rag] markdown 解析失败，退化为空文档', error);
        next = [];
      }
    }
    editor.replaceBlocks(editor.document, next.length > 0 ? next : [{ type: 'paragraph', content: '' }]);
    lastLoadedRef.current = markdown;
    setReady(true);
    readyRef.current?.(editor);
  }, [editor, markdown]);

  // 笔记增删时不会产生文档事务，手动 dispatch 一次让 props.decorations 重算。
  useEffect(() => {
    const view = editor?.prosemirrorView;
    if (!view) return;
    try {
      view.dispatch(view.state.tr.setMeta('rag-notes-refresh', Date.now()));
    } catch (error) {
      console.warn('[dsh-rag] 笔记高亮刷新失败', error);
    }
  }, [editor, notes]);

  // 卸载时告诉宿主编辑器已经没了，免得笔记锚点还指向上一份文档的块 id。
  useEffect(() => () => { readyRef.current?.(null); }, [editor]);

  const handleChange = useCallback(() => {
    if (!editor || !ready) return;
    try {
      const md = editor.blocksToMarkdownLossy(editor.document);
      lastLoadedRef.current = md;
      onChange?.(md);
    } catch (error) {
      console.warn('[dsh-rag] markdown 序列化失败', error);
    }
  }, [editor, ready, onChange]);

  if (!editor) return null;

  return (
    <div className="rag-editor-shell">
      <style data-plugin="dsh-rag">{mantineCss}</style>
      <BlockNoteView editor={editor} theme={theme} editable={!readOnly} onChange={handleChange} />
    </div>
  );
}

/**
 * 把笔记锚到当前光标所在块。
 * 存 { blockId, quote, offset }：quote 是整块纯文本，offset 是光标在块内的字符偏移。
 * blockId 只在当前编辑器实例内有效；offset 让「同一块里被改了几个字」还能指回原处。
 */
export function currentAnchor(editor) {
  if (!editor) return null;
  try {
    const position = editor.getTextCursorPosition();
    const block = position?.block;
    if (!block) return null;
    const text = plainText(block);
    const picked = selectionRange(editor, block);
    const start = picked?.start ?? cursorOffset(editor);
    return {
      blockId: block.id,
      quote: text,
      offset: start,
      // 划词选中时记下具体片段，右栏高亮和气泡都靠它；旧笔记没有这两个字段，
      // 渲染层要能退回「整块 + 块首气泡」。
      start,
      highlight: picked?.highlight ?? '',
      type: block.type,
    };
  } catch {
    return null;
  }
}

/** 当前选区若落在 block 内，返回块内起止偏移与选中文字。 */
function selectionRange(editor, block) {
  try {
    const view = editor.prosemirrorView;
    const { selection } = view.state;
    if (!selection || selection.empty) return null;
    let nodePos = null;
    view.state.doc.descendants((node, pos) => {
      if (nodePos !== null) return false;
      if (node.isTextblock && node.attrs?.id === block.id) { nodePos = pos; return false; }
      return true;
    });
    if (nodePos === null) return null;
    const base = nodePos + 1;
    const start = selection.from - base;
    const end = selection.to - base;
    if (start < 0 || end <= start) return null;
    const highlight = view.state.doc.textBetween(selection.from, selection.to, '\n');
    if (!highlight.trim()) return null;
    return { start, end, highlight };
  } catch {
    return null;
  }
}

/**
 * 把笔记锚点翻译成 ProseMirror 装饰：黄色底 + 选中片段末尾一个评论气泡。
 * 锚点失效（块没了、文字变了）就跳过，不画半截。
 */
function buildNoteDecorations(state, notes, onClick) {
  if (!Array.isArray(notes) || notes.length === 0) return DecorationSet.empty;
  const blocks = [];
  state.doc.descendants((node, pos) => {
    if (node.isTextblock) blocks.push({ node, pos, text: node.textContent });
  });
  if (blocks.length === 0) return DecorationSet.empty;

  const decorations = [];
  for (const note of notes) {
    const anchor = note?.anchor;
    if (!anchor) continue;
    let target = anchor.blockId ? blocks.find((item) => item.node.attrs?.id === anchor.blockId) : null;
    if (!target) {
      const head = String(anchor.quote || '').trim().slice(0, 40);
      if (!head) continue;
      target = blocks.find((item) => item.text.trim().startsWith(head));
    }
    if (!target) continue;

    const { text } = target;
    const highlight = String(anchor.highlight || '');
    let start = Number.isFinite(anchor.start) ? anchor.start : (Number.isFinite(anchor.offset) ? anchor.offset : 0);
    if (highlight) {
      // 文字被改过就按内容重新找一遍，找不到就落到块内同一位置。
      if (text.slice(start, start + highlight.length) !== highlight) {
        const found = text.indexOf(highlight);
        start = found >= 0 ? found : 0;
      }
    }
    start = Math.max(0, Math.min(start, text.length));
    const from = target.pos + 1 + start;
    const length = highlight ? Math.min(highlight.length, text.length - start) : 0;
    const to = from + length;
    if (length > 0) decorations.push(Decoration.inline(from, to, { class: 'rag-note-hl' }));
    decorations.push(Decoration.widget(to, () => notePin(note, onClick), { key: note.id, side: 1 }));
  }
  return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
}

/** 行内评论气泡：不抢焦点，点了把对应笔记卡片亮出来。 */
function notePin(note, onClick) {
  const pin = document.createElement('span');
  pin.className = 'rag-note-pin';
  pin.dataset.noteId = note.id;
  pin.setAttribute('role', 'button');
  pin.tabIndex = 0;
  pin.title = String(note.text || '笔记').slice(0, 80);
  pin.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13.2 2.9H2.8v8.1h2.6v2.1l3-2.1h4.8z" fill="currentColor"/></svg>';
  const fire = (event) => { event.preventDefault(); event.stopPropagation(); onClick?.(note.id); };
  pin.addEventListener('mousedown', (event) => event.preventDefault());
  pin.addEventListener('click', fire);
  pin.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') fire(event); });
  return pin;
}

/** 笔记气泡在编辑区里的位置（相对编辑区内容顶部），供右栏卡片对齐用。 */
export function notePinTops(editor) {
  const map = {};
  if (!editor?.prosemirrorView) return map;
  const view = editor.prosemirrorView;
  const rect = view.dom.getBoundingClientRect();
  const base = rect.top - view.dom.scrollTop;
  view.dom.parentElement?.querySelectorAll?.('.rag-note-pin').forEach((pin) => {
    const id = pin.dataset.noteId;
    if (!id) return;
    map[id] = pin.getBoundingClientRect().top - base;
  });
  return map;
}

/** 光标在本块纯文本里的字符偏移（拿不到就退回 0）。 */
function cursorOffset(editor) {
  try {
    const view = editor.prosemirrorView;
    const { selection } = view.state;
    const $from = selection.$from;
    if (!$from?.start) return 0;
    let offset = 0;
    view.state.doc.nodesBetween($from.start(), $from.pos, (node) => {
      if (node.isText) offset += node.text?.length ?? 0;
    });
    return offset;
  } catch {
    return 0;
  }
}

function plainText(block) {
  if (!block) return '';
  const walk = (node) => {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (typeof node.text === 'string') return node.text;
    if (Array.isArray(node.content)) return node.content.map(walk).join('');
    if (node.content && typeof node.content === 'object') return walk(node.content);
    return '';
  };
  return walk(block);
}

function flattenBlocks(blocks, out = []) {
  for (const block of blocks || []) {
    out.push(block);
    if (block.children?.length) flattenBlocks(block.children, out);
  }
  return out;
}

/**
 * 定位笔记锚点，按四档回退：
 *   1. blockId 命中且文本仍以 quote 开头 → 'exact'
 *   2. 别的块文本与 quote 相同/以之开头（块被拖动过）→ 'moved'
 *   3. 某块仍包含这段文字（块内改了几个字）→ 'shifted'
 *   4. 都找不到 → 'missing'
 * 只有 'missing' 才是真的失效；前三种都不该打扰用户。
 */
export function resolveAnchor(editor, anchor) {
  if (!editor || !anchor) return { status: 'missing', block: null };
  const all = flattenBlocks(editor.document);
  const quote = String(anchor.quote || '').trim();
  const head = quote.slice(0, 40);

  if (anchor.blockId) {
    const byId = all.find((block) => block.id === anchor.blockId);
    if (byId) {
      if (!head || plainText(byId).trim().startsWith(head)) return { status: 'exact', block: byId };
      if (quote && plainText(byId).includes(quote)) return { status: 'shifted', block: byId };
      // id 还在但内容被整段换掉：继续往下按 quote 找。
    }
  }

  if (!head) return { status: 'missing', block: null };
  const same = all.find((block) => plainText(block).trim().startsWith(head));
  if (same) return { status: 'moved', block: same };

  if (quote) {
    const partial = all.find((block) => plainText(block).includes(quote.slice(0, Math.min(12, quote.length))));
    if (partial) return { status: 'shifted', block: partial };
  }
  return { status: 'missing', block: null };
}

/** 兼容旧调用：只关心块。 */
export function resolveBlock(editor, anchor) {
  const resolved = resolveAnchor(editor, anchor);
  return resolved.block ?? null;
}

/**
 * 把编辑器光标移到笔记锚定的块并滚进视野。返回 { status, placed }，
 * status 含义同 resolveAnchor；placed 表示光标是否精确落在原偏移。
 */
export function focusBlock(editor, anchor) {
  const { status, block } = resolveAnchor(editor, anchor);
  if (!block) return { status: 'missing', placed: false };
  try {
    if (status === 'exact' && Number.isFinite(anchor?.offset) && anchor.offset > 0) {
      placeCursorAtOffset(editor, block, anchor.offset);
    } else {
      editor.setTextCursorPosition(block.id, 'end');
    }
  } catch {
    return { status, placed: false };
  }
  requestAnimationFrame(() => {
    const node = document.querySelector(`[data-id="${CSS.escape(block.id)}"]`);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  return { status, placed: true };
}

/** 把光标放到块内第 offset 个字符之后；失败就退到块尾。 */
function placeCursorAtOffset(editor, block, offset) {
  const view = editor.prosemirrorView;
  const all = flattenBlocks(editor.document);
  const index = all.indexOf(block);
  if (index < 0) return;
  let pos = null;
  let seen = 0;
  view.state.doc.descendants((node, nodePos) => {
    if (pos !== null) return false;
    if (!node.isTextblock || !node.textContent.startsWith(plainText(block).slice(0, 1))) return true;
    if (node.textContent !== plainText(block)) return true;
    seen += 1;
    const want = Math.min(offset, node.textContent.length);
    pos = nodePos + 1 + want;
    return false;
  });
  if (pos === null) return;
  const tr = view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos)));
  view.dispatch(tr);
  view.focus();
}
