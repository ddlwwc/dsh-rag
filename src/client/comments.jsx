import { useEffect, useRef, useState } from 'react';

// 评论正文的轻格式：只存 markdown 源文本，卡片里自己渲染。不引富文本编辑器 ——
// 评论输入框出现时不能抢正文的焦点，越轻越好。
const EMOJIS = ['👍', '🙂', '😄', '🤔', '😅', '😮', '🎉', '❤️', '🔥', '✅', '❓', '💡', '📌', '⭐', '👀', '🙏'];

function timeText(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
}

/** 行内轻格式：**粗** *斜* `代码` [文字](链接) ![图](src)。返回 React 节点，不用 innerHTML。 */
function inline(text) {
  const nodes = [];
  let rest = text;
  let key = 0;
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\))/;
  while (rest) {
    const match = pattern.exec(rest);
    if (!match) { nodes.push(rest); break; }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const token = match[0];
    key += 1;
    if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) nodes.push(<code key={key} className="rag-code">{token.slice(1, -1)}</code>);
    else if (token.startsWith('![')) {
      const src = token.slice(token.indexOf('](') + 2, -1);
      nodes.push(<img key={key} className="rag-note-img" src={src} alt="" />);
    } else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']('));
      const href = token.slice(token.indexOf('](') + 2, -1);
      nodes.push(<a key={key} href={href} target="_blank" rel="noreferrer">{label}</a>);
    } else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    rest = rest.slice(match.index + token.length);
  }
  return nodes;
}

/** 把评论正文渲染成小块：段落、无序/有序列表、图片段落。 */
export function RichText({ text }) {
  const blocks = [];
  let list = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(<Tag key={`l${blocks.length}`} className="rag-note-list">{list.items.map((item, i) => <li key={i}>{inline(item)}</li>)}</Tag>);
    list = null;
  };
  for (const line of String(text || '').split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const orderedFlag = Boolean(ordered);
      if (!list || list.ordered !== orderedFlag) { flush(); list = { ordered: orderedFlag, items: [] }; }
      list.items.push((bullet || ordered)[1]);
      continue;
    }
    flush();
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`} className="rag-note-p">{inline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

/** 轻格式工具条：把选中的文字包成 markdown，或者插入一张图/一个表情。 */
function Toolbar({ onFormat, onImage }) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const btn = (label, title, run, className = '') => (
    <button
      type="button"
      className={'rag-tool ' + className}
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >{label}</button>
  );
  return (
    <div className="rag-toolbar">
      {btn(<b>B</b>, '加粗', () => onFormat('bold'))}
      {btn(<i>I</i>, '斜体', () => onFormat('italic'))}
      {btn(<code className="rag-code">{"</>"}</code>, '行内代码', () => onFormat('code'))}
      {btn('•', '无序列表', () => onFormat('bullet'))}
      {btn('1.', '有序列表', () => onFormat('ordered'))}
      {btn('🔗', '链接', () => onFormat('link'))}
      {btn('🖼', '插入图片', onImage)}
      <span className="rag-tool-emoji">
        {btn('🙂', '表情', () => setEmojiOpen((v) => !v))}
        {emojiOpen && (
          <span className="rag-emoji-pop">
            {EMOJIS.map((emoji) => (
              <button key={emoji} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setEmojiOpen(false); onFormat('emoji', emoji); }}>{emoji}</button>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

/** 划词评论输入框。**不自动聚焦**：用户还在正文里选字时不能被抢走焦点。 */
export function Composer({ value, onChange, onSubmit, onCancel, onImage, onFormat, inputRef }) {
  return (
    <div className="rag-composer">
      <textarea
        ref={inputRef}
        value={value}
        placeholder="请添加评论…"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') onSubmit();
          if (event.key === 'Escape') onCancel();
        }}
      />
      <Toolbar onFormat={onFormat} onImage={onImage} />
      <div className="rag-composer-actions">
        <button type="button" className="rag-btn rag-btn-primary" disabled={!value.trim()} onClick={onSubmit}>评论</button>
        <button type="button" className="rag-btn" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

/**
 * 一条划词评论：楼层结构（主楼 + N 条回复）。
 * 三个操作只在悬停时出现，平时就是一张安静的卡片。
 */
/** 把 markdown 标记塞进 textarea 的当前选区，返回新文本（评论输入框的工具条共用）。 */
function insertFormat(text, start, end, kind, argument, fallback = '文字') {
  const selected = text.slice(start, end);
  const wrap = (left, right) => text.slice(0, start) + left + (selected || fallback) + right + text.slice(end);
  if (kind === 'bold') return wrap('**', '**');
  if (kind === 'italic') return wrap('*', '*');
  if (kind === 'code') return wrap('`', '`');
  if (kind === 'link') return wrap('[', '](https://)');
  if (kind === 'bullet') return text.slice(0, start) + '- ' + text.slice(start);
  if (kind === 'ordered') return text.slice(0, start) + '1. ' + text.slice(start);
  if (kind === 'emoji') return text.slice(0, start) + (argument || '🙂') + text.slice(end);
  return text;
}

export function NoteCard({ note, status, onLocate, onDelete, onEdit, onReply, onImage }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text || '');
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState('');
  const replyRef = useRef(null);
  const replies = Array.isArray(note.replies) ? note.replies : [];

  const sendReply = (value) => {
    const body = String(value ?? replyText).trim();
    if (!body) return;
    onReply(body);
    setReplyText('');
    setReplying(false);
  };

  const formatReply = (kind, argument) => {
    const el = replyRef.current;
    const start = el?.selectionStart ?? replyText.length;
    const end = el?.selectionEnd ?? replyText.length;
    setReplyText(insertFormat(replyText, start, end, kind, argument));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
    });
  };

  useEffect(() => { setText(note.text || ''); }, [note.text]);

  return (
    <div className="rag-card">
      <div className="rag-card-main">
        <div className="rag-card-meta">
          <span className="rag-card-avatar" aria-hidden="true">我</span>
          <span className="rag-card-who">我</span>
          <span className="rag-card-time">{timeText(note.createdAt)}</span>
          <span className="rag-card-tools">
            <button type="button" className="rag-link" onClick={onLocate}>定位</button>
            <button type="button" className="rag-link" onClick={() => setEditing((v) => !v)}>编辑</button>
            <button type="button" className="rag-link is-danger" onClick={onDelete}>删除</button>
          </span>
        </div>
        {note.anchor?.quote && <p className="rag-card-quote">「{note.anchor.quote.slice(0, 80)}」</p>}
        {editing ? (
          <div className="rag-card-edit">
            <textarea value={text} onChange={(e) => setText(e.target.value)} />
            <div className="rag-card-edit-actions">
              <button type="button" className="rag-btn rag-btn-primary" onClick={() => { onEdit(text.trim()); setEditing(false); }}>保存</button>
              <button type="button" className="rag-btn" onClick={() => { setText(note.text || ''); setEditing(false); }}>取消</button>
            </div>
          </div>
        ) : (
          <div className="rag-card-body"><RichText text={note.text} /></div>
        )}
        {status === 'missing' && <p className="rag-note-drift">这段文字已经不在了。</p>}
        {status === 'shifted' && <p className="rag-note-drift">这段文字有改动，位置可能不准。</p>}
      </div>

      {replies.map((reply, index) => (
        <div key={reply.id} className="rag-floor">
          <span className="rag-floor-index">{index + 1}楼</span>
          <div className="rag-floor-body">
            <RichText text={reply.text} />
            <span className="rag-floor-time">{timeText(reply.createdAt)}</span>
          </div>
        </div>
      ))}

      {replying ? (
        <div className="rag-card-reply">
          <Composer
            inputRef={replyRef}
            value={replyText}
            onChange={setReplyText}
            onSubmit={() => sendReply()}
            onCancel={() => { setReplying(false); setReplyText(''); }}
            onImage={() => onImage?.((snippet) => setReplyText((current) => current + snippet))}
            onFormat={formatReply}
          />
        </div>
      ) : (
        <button
          type="button"
          className="rag-link rag-card-reply-btn"
          onClick={() => { setReplyText(''); setReplying(true); }}
        >回复</button>
      )}
    </div>
  );
}
