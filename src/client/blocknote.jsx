import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
// 编辑器自带的多语言词典：不传就全是英文（斜杠菜单、气泡工具条、占位符都是）。
import { zh } from '@blocknote/core/locales';
// CSS 走 text loader 内联（构建时把 @import 递归展开）：DSH 不保证宿主能加载插件的独立样式表。
import mantineCss from '@blocknote/mantine/style.css';

// ── 划词评论的正文标记 ─────────────────────────────────────
// 正文里只加「背景高亮」这一种装饰：不插 widget、不拦截鼠标事件、不改文档结构。
// 上一版往正文插气泡被判定为「编辑手感坏了」，这次一律不碰正文节点的 DOM。
const annotationStore = { notes: [], onClick: null };

/** 组件把最新的评论列表推进来；不进 react state，避免每次装饰计算都重渲染整篇。 */
export function setAnnotationNotes(notes) {
  annotationStore.notes = Array.isArray(notes) ? notes : [];
}

/** 装饰是跟着 transaction 算的：评论增删后主动空转一次，正文才会马上变色。 */
export function refreshAnnotations(editor) {
  try {
    const view = editor?.prosemirrorView;
    if (!view) return;
    view.dispatch(view.state.tr.setMeta('dsh-rag-annotations', Date.now()));
  } catch {
    // 编辑器已经销毁，忽略
  }
}

/**
 * BlockNote 0.57 的块结构是 doc > blockGroup > blockContainer(attrs.id) > blockContent(文本块)：
 * id 挂在容器上，文字在它里面的文本块里。所以「按位置取 id」要往上爬，「按 id 取位置」要往下找。
 * 老文档里文本块自己带 id 的情况也顺手兜住。
 */
function blockIdAt($pos) {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const id = $pos.node(depth)?.attrs?.id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

function textblockAt($pos) {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node?.isTextblock) return { node, pos: $pos.start(depth) - 1 };
  }
  return null;
}

function textblockById(doc, id) {
  let container = null;
  doc.descendants((node, pos) => {
    if (container) return false;
    if (node.attrs?.id === id) {
      container = { node, pos };
      return false;
    }
    return true;
  });
  if (!container) return null;
  if (container.node.isTextblock) return { node: container.node, pos: container.pos };
  let found = null;
  container.node.descendants((node, pos) => {
    if (found) return false;
    if (node.isTextblock) {
      found = { node, pos: container.pos + 1 + pos };
      return false;
    }
    return true;
  });
  return found;
}

const annotationPlugin = new Plugin({
  key: new PluginKey('dsh-rag-annotations'),
  props: {
    decorations(state) {
      const decos = [];
      for (const note of annotationStore.notes) {
        const anchor = note?.anchor;
        const quote = typeof anchor?.quote === 'string' ? anchor.quote : '';
        const start = Number(anchor?.start);
        if (!anchor?.blockId || !quote || !Number.isFinite(start) || start < 0) continue;
        const found = textblockById(state.doc, anchor.blockId);
        if (!found) continue;
        const textStart = found.pos + 1;
        const textSize = found.node.content.size;
        const from = textStart + Math.min(start, textSize);
        const to = Math.min(from + quote.length, textStart + textSize);
        if (to <= from) continue;
        decos.push(Decoration.inline(from, to, { class: 'rag-ann', 'data-note-id': note.id }));
      }
      return DecorationSet.create(state.doc, decos);
    },
    handleDOMEvents: {
      mousedown(_view, event) {
        const handler = annotationStore.onClick;
        if (!handler || !(event.target instanceof Element)) return false;
        const hit = event.target.closest('[data-note-id]');
        if (!hit) return false;
        // 不 preventDefault：用户点高亮处仍然可以正常把光标放进去打字。
        handler(hit.getAttribute('data-note-id'));
        return false;
      },
    },
  },
});

const annotationExtension = { key: 'dsh-rag-annotations', prosemirrorPlugins: [annotationPlugin] };

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
  markdown, blocks, onChange, onReady, onUpload, onSelect, onAnnotationClick, theme = 'light', readOnly = false,
}) {
  const [ready, setReady] = useState(false);
  const lastLoadedRef = useRef(null);
  const uploadRef = useRef(onUpload);
  uploadRef.current = onUpload;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const clickRef = useRef(onAnnotationClick);
  clickRef.current = onAnnotationClick;

  const options = useMemo(() => ({
    // 词典必须在建编辑器时给：BlockNoteView 没有 dictionary 这个 prop，视图的斜杠菜单读的是编辑器实例上的词典。
    dictionary: zh,
    // 默认关闭 emoji 词典（构建时已 stub），图片走宿主上传。
    uploadFile: async (file) => {
      const handler = uploadRef.current;
      if (!handler) throw new Error('当前知识库不支持上传附件');
      return handler(file);
    },
    // 扩展的注册形态是「工厂函数」：BlockNote 会用 ctx 调一次，拿到真正的 Extension 实例。
    extensions: [() => annotationExtension],
  }), []);
  const editor = useCreateBlockNote(options);

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

  useEffect(() => {
    annotationStore.onClick = (id) => clickRef.current?.(id);
    return () => { annotationStore.onClick = null; };
  }, []);

  if (!editor) return null;

  return (
    <div className="rag-editor-shell">
      <style data-plugin="dsh-rag">{mantineCss}</style>
      <BlockNoteView
        editor={editor}
        theme={theme}
        editable={!readOnly}
        onChange={handleChange}
        onSelectionChange={() => {
          const anchor = selectionAnchor(editor);
          if (!anchor) {
            let detail = null;
            try {
              const view = editor?.prosemirrorView;
              if (!view) detail = { hasView: false };
              else {
                const { state } = view;
                const $from = state.selection.$from;
                detail = {
                  hasView: true,
                  from: state.selection.from,
                  to: state.selection.to,
                  depth: $from.depth,
                  nodeName: $from.parent?.type?.name,
                  nodeId: $from.parent?.attrs?.id ?? null,
                  parentIsBlock: Boolean($from.parent?.isTextblock),
                  textLen: $from.parent?.content?.size,
                };
              }
            } catch (error) {
              detail = { error: String(error?.message ?? error) };
            }
          }
          selectRef.current?.(anchor);
        }}
      />
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
    return {
      blockId: block.id,
      block: text,
      quote: '',
      start: cursorOffset(editor),
      type: block.type,
    };
  } catch {
    return null;
  }
}

/**
 * 选区锚点：评论挂在「块内的一段文字」上，而不是整个块。
 * 存 { blockId, block, quote, start }：block 是块的纯文本（回退找块用），
 * quote 是选中的文字（高亮范围），start 是这段文字在块内的起始偏移。
 */
export function selectionAnchor(editor) {
  if (!editor) return null;
  try {
    const view = editor.prosemirrorView;
    if (!view) return null;
    const { state } = view;
    const { from, to } = state.selection;
    if (from === to) return null;
    const around = textblockAt(state.selection.$from);
    if (!around) return null;
    const blockId = blockIdAt(state.selection.$from);
    if (!blockId) return null;
    const textStart = around.pos + 1;
    const size = around.node.content.size;
    const start = Math.max(0, Math.min(from - textStart, size));
    const end = Math.max(start, Math.min(to - textStart, size));
    const quote = state.doc.textBetween(textStart + start, textStart + end, ' ');
    if (!quote.trim()) return null;
    return {
      blockId,
      block: state.doc.textBetween(textStart, textStart + size, ' '),
      quote,
      start,
      type: around.node.type.name,
    };
  } catch {
    return null;
  }
}

/**
 * 锚点在正文里的位置：top 是相对正文内容顶部的像素偏移（正文滚动时不变），
 * docTop 是当前视口里的绝对 y，用来判断这一段有没有滚出可视区。
 */
export function anchorGeometry(editor, anchor) {
  if (!editor || !anchor?.blockId) return null;
  try {
    const view = editor.prosemirrorView;
    if (!view) return null;
    const found = textblockById(view.state.doc, anchor.blockId);
    if (!found) return null;
    const size = found.node.content.size;
    const start = Math.max(0, Math.min(Number(anchor.start) || 0, size));
    const coords = view.coordsAtPos(found.pos + 1 + start);
    const rect = view.dom.getBoundingClientRect();
    return {
      top: coords.top - rect.top,
      height: Math.max(1, coords.bottom - coords.top),
      docTop: coords.top,
      docBottom: view.dom.getBoundingClientRect().bottom,
      docViewTop: rect.top,
    };
  } catch {
    return null;
  }
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
  if (!editor || !anchor) return { status: 'missing', block: null, start: null, length: 0 };
  const all = flattenBlocks(editor.document);
  const quote = String(anchor.quote || '').trim();
  // 老笔记的 quote 存的是整块文本；新笔记的 quote 是块内选中那一小段。
  const head = quote.slice(0, 40);
  const withStart = (block) => {
    const text = plainText(block);
    if (Number.isFinite(anchor.start) && anchor.start >= 0) {
      const sliced = text.slice(anchor.start, anchor.start + quote.length);
      if (!quote || sliced === quote) return { block, start: anchor.start, length: quote.length };
    }
    const index = quote ? text.indexOf(quote) : -1;
    return { block, start: index >= 0 ? index : null, length: index >= 0 ? quote.length : 0 };
  };

  if (anchor.blockId) {
    const byId = all.find((block) => block.id === anchor.blockId);
    if (byId) {
      const text = plainText(byId);
      if (!head || text.trim().startsWith(head) || (quote && text.includes(quote))) {
        const status = (!head || text.trim().startsWith(head)) ? 'exact' : 'shifted';
        return { status, ...withStart(byId) };
      }
    }
  }

  if (!head) return { status: 'missing', block: null, start: null, length: 0 };
  const same = all.find((block) => plainText(block).trim().startsWith(head));
  if (same) return { status: 'moved', ...withStart(same) };

  if (quote) {
    const partial = all.find((block) => plainText(block).includes(quote.slice(0, Math.min(12, quote.length))));
    if (partial) return { status: 'shifted', ...withStart(partial) };
  }
  return { status: 'missing', block: null, start: null, length: 0 };
}

/** 兼容旧调用：只关心块。 */
export function resolveBlock(editor, anchor) {
  const resolved = resolveAnchor(editor, anchor);
  return resolved.block ?? null;
}

/**
 * 把编辑器定位到评论锚定的那段文字：能精确定位就选中它，否则退到块尾。
 * 滚动用的是块节点自身，不动整页布局。
 */
export function focusBlock(editor, anchor) {
  const { status, block, start, length } = resolveAnchor(editor, anchor);
  if (!block) return { status: 'missing', placed: false };
  const view = editor.prosemirrorView;
  try {
    if (view) {
      const found = textblockById(view.state.doc, block.id);
      if (found) {
        const textStart = found.pos + 1;
        const size = found.node.content.size;
        if (Number.isFinite(start) && length > 0) {
          const from = textStart + Math.min(start, size);
          const to = Math.min(from + length, textStart + size);
          view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(from))));
          view.focus();
          requestAnimationFrame(() => {
            const coords = view.coordsAtPos(from);
            view.dom.scrollIntoView({ block: 'center', behavior: 'smooth' });
            void coords;
          });
          return { status, placed: true };
        }
        view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(textStart))));
        view.focus();
        requestAnimationFrame(() => view.dom.scrollIntoView({ block: 'center', behavior: 'smooth' }));
        return { status, placed: true };
      }
    }
    editor.setTextCursorPosition(block.id, 'end');
  } catch {
    return { status, placed: false };
  }
  return { status, placed: true };
}
