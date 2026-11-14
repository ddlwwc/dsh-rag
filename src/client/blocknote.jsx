import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
export function MarkdownEditor({ markdown, blocks, onChange, onReady, onUpload, theme = 'light', readOnly = false }) {
  const [ready, setReady] = useState(false);
  const lastLoadedRef = useRef(null);
  const uploadRef = useRef(onUpload);
  uploadRef.current = onUpload;

  const options = useMemo(() => ({
    // 默认关闭 emoji 词典（构建时已 stub），图片走宿主上传。
    uploadFile: async (file) => {
      const handler = uploadRef.current;
      if (!handler) throw new Error('当前知识库不支持上传附件');
      return handler(file);
    },
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

  if (!editor) return null;

  return (
    <div className="rag-editor-shell">
      <style data-plugin="dsh-rag">{mantineCss}</style>
      <BlockNoteView editor={editor} dictionary={zh} theme={theme} editable={!readOnly} onChange={handleChange} />
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
      quote: text,
      offset: cursorOffset(editor),
      type: block.type,
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
