// 左侧库树的一行：目录可折叠、可拖拽接收，文档可拖拽移动、可勾选导出。
import { useState } from 'react';
import { DocIcon, FolderIcon } from './icons.jsx';

export function TreeNode({ node, depth, activePath, dragging, dropTarget, selected, onToggleSelect, onOpen, onDelete, onDragStart, onDragOver, onDropEntry }) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: 8 + depth * 14 };

  if (node.type === 'dir') {
    const isDrop = dropTarget === node.relPath;
    return (
      <div className="rag-node">
        <div
          className={'rag-row is-dir' + (isDrop ? ' is-drop' : '')}
          style={pad}
          onClick={() => setOpen((v) => !v)}
          onDragOver={(e) => { if (dragging) { e.preventDefault(); e.stopPropagation(); onDragOver(node.relPath); } }}
          onDragLeave={() => onDragOver('')}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDropEntry(dragging, node.relPath);
            onDragOver('');
          }}
        >
          <span className="rag-caret">{open ? '▾' : '▸'}</span>
          <FolderIcon />
          <span className="rag-name">{node.name}</span>
        </div>
        {open && (node.children || []).map((child) => (
          <TreeNode
            key={child.relPath}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            dragging={dragging}
            dropTarget={dropTarget}
            selected={selected}
            onToggleSelect={onToggleSelect}
            onOpen={onOpen}
            onDelete={onDelete}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDropEntry={onDropEntry}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={'rag-row' + (activePath === node.relPath ? ' is-active' : '')}
      style={pad}
      draggable
      onDragStart={(e) => { e.stopPropagation(); onDragStart(node.relPath); }}
      onDragEnd={() => onDragStart('')}
      onClick={() => onOpen(node.relPath)}
    >
      <input
        type="checkbox"
        className="rag-check"
        checked={selected?.has(node.relPath) ?? false}
        onChange={() => onToggleSelect?.(node.relPath)}
        onClick={(e) => e.stopPropagation()}
        aria-label={'选择 ' + node.name}
      />
      <DocIcon />
      <span className="rag-name" title={node.relPath}>{node.name}</span>
      <span className="rag-row-tools" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => onDelete(node.relPath)} title="删除">✕</button>
      </span>
    </div>
  );
}



