import { useCallback, useEffect, useRef, useState } from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
// CSS 走 text loader 内联（构建时把 @import 递归展开）：DSH 不保证宿主能加载插件的独立样式表。
import mantineCss from '@blocknote/mantine/style.css';

/**
 * markdown → BlockNote → markdown 的桥。
 * 正文永远以 md 为准：进来先 parse，出去用 blocksToMarkdownLossy，块级 JSON 只留在内存里。
 */
export function MarkdownEditor({ markdown, onChange, onReady, readOnly = false }) {
  const [ready, setReady] = useState(false);
  const lastLoadedRef = useRef(null);
  const editor = useCreateBlockNote({ initialContent: undefined });

  useEffect(() => {
    if (!editor) return;
    // 回声：用户打字 → onChange 把 md 写回 state → 又回到这里。内容相同就不重建块，
    // 否则每敲一个字都会重解析整篇、光标被重置。
    if (markdown === lastLoadedRef.current) return;
    const blocks = editor.tryParseMarkdownToBlocks(markdown ?? '');
    editor.replaceBlocks(editor.document, blocks.length > 0 ? blocks : [{ type: 'paragraph', content: '' }]);
    lastLoadedRef.current = markdown;
    setReady(true);
    onReady?.(editor);
  }, [editor, markdown, onReady]);

  // 卸载时告诉宿主编辑器已经没了，免得笔记锚点还指向上一份文档的块 id。
  useEffect(() => () => { onReady?.(null); }, [onReady]);

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
      <BlockNoteView editor={editor} theme="light" editable={!readOnly} onChange={handleChange} />
    </div>
  );
}

/** 把笔记锚到当前光标所在块：返回 { blockId, quote }。 */
export function currentAnchor(editor) {
  if (!editor) return null;
  try {
    const position = editor.getTextCursorPosition();
    const block = position?.block;
    if (!block) return null;
    return { blockId: block.id, quote: plainText(block) };
  } catch {
    return null;
  }
}

function plainText(block) {
  if (!block) return '';
  const walk = (node) => {
    if (!node) return '';
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
 * 定位笔记锚点。blockId 只在当前编辑器实例内有效，重开文档后必然失效，
 * 所以退到「块文本开头匹配 quote」——原文被改动了才真的找不到。
 */
export function resolveBlock(editor, anchor) {
  if (!editor || !anchor) return null;
  const all = flattenBlocks(editor.document);
  const blockId = typeof anchor === 'string' ? anchor : anchor.blockId;
  if (blockId) {
    const byId = all.find((block) => block.id === blockId);
    if (byId) return byId;
  }
  const quote = String(typeof anchor === 'string' ? '' : anchor.quote || '').trim();
  const head = quote.slice(0, 40);
  if (!head) return null;
  return all.find((block) => plainText(block).trim().startsWith(head)) ?? null;
}

/** 把编辑器光标移到笔记锚定的块，并滚进视野。返回 false 表示锚点已经找不到。 */
export function focusBlock(editor, anchor) {
  const block = resolveBlock(editor, anchor);
  if (!block) return false;
  try {
    editor.setTextCursorPosition(block.id, 'end');
  } catch {
    return false;
  }
  requestAnimationFrame(() => {
    const node = document.querySelector(`[data-id="${CSS.escape(block.id)}"]`);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  return true;
}
