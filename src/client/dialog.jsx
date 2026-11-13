// 应用内对话框：Electron 渲染进程没有 window.prompt，confirm 也会阻塞，
// 所以「输入名字 / 确认删除」这类交互必须自带。
import { useEffect, useRef, useState } from 'react';

/**
 * 极简应用内对话框：text 输入（返回字符串或 null）、confirm（返回 true/false）。
 * 不用 window.prompt/confirm —— 桌面端 prompt 不存在，confirm 也会阻塞渲染进程。
 */
export function PromptDialog({ dialog, onOk, onCancel }) {
  const [text, setText] = useState(dialog.initial ?? '');
  const inputRef = useRef(null);

  useEffect(() => {
    if (dialog.kind === 'text') inputRef.current?.focus();
  }, [dialog.kind]);

  return (
    <div className="rag-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <form
        className="rag-modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (dialog.kind === 'confirm') onOk(true);
          else if (text.trim()) onOk(text.trim());
        }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}
      >
        <p className="rag-modal-title">{dialog.title}</p>
        {dialog.kind === 'text' && (
          <input
            ref={inputRef}
            className="rag-modal-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="输入后回车确定"
          />
        )}
        <div className="rag-modal-actions">
          <button type="button" className="rag-btn" onClick={onCancel}>取消</button>
          <button type="submit" className="rag-btn rag-btn-primary">{dialog.kind === 'confirm' ? '确定' : '创建'}</button>
        </div>
      </form>
    </div>
  );
}

