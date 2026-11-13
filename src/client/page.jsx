import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from './api.js';
import { MarkdownEditor, currentAnchor, focusBlock } from './blocknote.jsx';

const SAVE_DELAY = 900;

export function RagPage({ ctx, onStartRole }) {
  const [libraries, setLibraries] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [tree, setTree] = useState([]);
  const [doc, setDoc] = useState(null);
  const [notes, setNotes] = useState([]);
  const [roles, setRoles] = useState([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(null);
  const [mode, setMode] = useState('rich');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draftNote, setDraftNote] = useState(null);
  const [dragging, setDragging] = useState('');
  const [dropTarget, setDropTarget] = useState('');

  const [dialog, setDialog] = useState(null);
  const dialogResolve = useRef(null);

  /**
   * 应用内对话框。Electron 的渲染进程没有 window.prompt（调用直接抛错），
   * 所以所有「输入名字 / 确认删除」都必须走这里。
   */
  const ask = useCallback((options) => new Promise((resolve) => {
    dialogResolve.current = resolve;
    setDialog(options);
  }), []);
  const settleDialog = useCallback((value) => {
    const resolve = dialogResolve.current;
    dialogResolve.current = null;
    setDialog(null);
    resolve?.(value);
  }, []);
  const askText = useCallback((title, initial = '') => ask({ kind: 'text', title, initial }), [ask]);
  const askConfirm = useCallback((title) => ask({ kind: 'confirm', title }), [ask]);

  const editorRef = useRef(null);
  const saveTimer = useRef(null);
  const noticeTimer = useRef(null);
  const openSeq = useRef(0);
  // 正文的最新值：防抖回调闭包里捕获的 doc.markdown 是「按键之前」的版本，直接拿它保存会丢最后一次改动。
  const latest = useRef({ markdown: '', dirty: false, conflict: false });
  const doSaveRef = useRef(null);

  const active = libraries.find((l) => l.id === activeId) || null;

  const toast = useCallback((message) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 2600);
  }, []);

  const fail = useCallback((err) => setError(errorText(err)), []);

  // ── 载入 ───────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [libs, roleList] = await Promise.all([api.listLibraries(), api.roles()]);
        if (!alive) return;
        setLibraries(libs.libraries || []);
        setRoles(roleList.roles || []);
        setActiveId((current) => current || (libs.libraries || [])[0]?.id || '');
      } catch (err) {
        if (alive) fail(err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [fail]);

  const refreshTree = useCallback(async (libraryId) => {
    if (!libraryId) return;
    try {
      const data = await api.tree(libraryId);
      setTree(data.tree || []);
      setLibraries((current) => current.map((l) => (l.id === data.library.id ? data.library : l)));
    } catch (err) {
      fail(err);
    }
  }, [askText, fail]);

  useEffect(() => {
    setDoc(null);
    setNotes([]);
    setHits(null);
    latest.current = { markdown: '', dirty: false, conflict: false };
    if (!activeId) { setTree([]); return; }
    refreshTree(activeId);
  }, [activeId, refreshTree]);

  // ── 保存 ───────────────────────────────────────────────
  // 从 latest 读正文，而不是从这次 render 闭包里的 doc 读。
  const doSave = useCallback(async (force = false) => {
    const { markdown, dirty, conflict } = latest.current;
    if (!doc || !activeId || !dirty) return;
    latest.current = { markdown, dirty: false, conflict };
    try {
      const saved = await api.saveDoc({
        library: activeId,
        path: doc.relPath,
        markdown,
        baseMtimeMs: force || conflict ? 0 : doc.mtimeMs,
      });
      setDoc((current) => (current && current.relPath === doc.relPath
        ? { ...current, mtimeMs: saved.saved.mtimeMs, size: saved.saved.size }
        : current));
      latest.current = { markdown, dirty: false, conflict: false };
      setNotice('已保存');
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(''), 1200);
    } catch (err) {
      // 失败要把脏标记还回去：否则「保存」按钮会因为 dirty=false 直接 return，用户的内容再没有出口。
      latest.current = { markdown, dirty: true, conflict: err?.status === 409 };
      setError(err?.status === 409
        ? '这个文件在别处被改过了。内容还留在这里：再点一次「保存」会强行覆盖，或先关掉重开这篇文档。'
        : errorText(err));
    }
  }, [activeId, doc]);
  doSaveRef.current = doSave;

  const flushSave = useCallback((force = false) => { void doSave(force); }, [doSave]);

  const handleChange = useCallback((markdown) => {
    latest.current = { ...latest.current, markdown, dirty: true };
    setDoc((current) => (current ? { ...current, markdown } : current));
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void doSave(); }, SAVE_DELAY);
  }, [doSave]);

  // 切文档 / 切面板 / 关页面之前，把没落盘的内容写下去。
  useEffect(() => {
    const flush = () => { if (latest.current.dirty) void doSaveRef.current?.(); };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      flush();
    };
  }, []);

  const openDoc = useCallback(async (relPath, libraryId = activeId) => {
    if (!libraryId || !relPath) return;
    if (doc && doc.relPath !== relPath && latest.current.dirty) await doSave();
    const seq = ++openSeq.current;
    try {
      setBusy('打开中…');
      const data = await api.doc(libraryId, relPath);
      if (seq !== openSeq.current) return;   // 用户已经点了另一篇，丢掉迟到的响应
      latest.current = { markdown: data.doc.markdown ?? '', dirty: false, conflict: false };
      setDoc(data.doc);
      setNotes(data.doc.notes || []);
      setDraftNote(null);
      setError('');
    } catch (err) {
      if (seq === openSeq.current) fail(err);
    } finally {
      if (seq === openSeq.current) setBusy('');
    }
  }, [activeId, doSave, fail]);

  // ── 笔记 ───────────────────────────────────────────────
  const persistNotes = useCallback(async (next) => {
    if (!activeId || !doc) return false;
    const previous = notes;
    setNotes(next);
    try {
      await api.saveNotes({ library: activeId, path: doc.relPath, notes: next });
      return true;
    } catch (err) {
      setNotes(previous);   // 磁盘没写成功，界面就别假装成功
      fail(err);
      return false;
    }
  }, [activeId, doc, notes, fail]);

  const beginNote = useCallback(() => {
    const anchor = currentAnchor(editorRef.current);
    setDraftNote({ text: '', anchor: anchor || { blockId: '', quote: '' } });
  }, []);

  const commitNote = useCallback(async () => {
    if (!draftNote || !draftNote.text.trim()) {
      setDraftNote(null);
      return;
    }
    const note = {
      id: newNoteId(),
      text: draftNote.text.trim(),
      anchor: draftNote.anchor,
      createdAt: Date.now(),
    };
    setDraftNote(null);
    if (await persistNotes([...notes, note])) toast('笔记已加');
  }, [draftNote, notes, persistNotes, toast]);

  const removeNote = useCallback(async (id) => {
    await persistNotes(notes.filter((n) => n.id !== id));
  }, [notes, persistNotes]);

  // ── 搜索 ───────────────────────────────────────────────
  useEffect(() => {
    if (!query.trim()) { setHits(null); return; }
    const timer = window.setTimeout(async () => {
      try {
        const data = await api.search(activeId, query.trim());
        setHits(data.hits || []);
      } catch (err) {
        fail(err);
      }
    }, 280);
    return () => window.clearTimeout(timer);
  }, [query, activeId, fail]);

  // ── 库操作 ─────────────────────────────────────────────
  const createLibrary = useCallback(async () => {
    const name = await askText('新建知识库', '');
    if (!name) return;
    try {
      const data = await api.createLibrary({ name });
      setLibraries((current) => [...current, data.library]);
      setActiveId(data.library.id);
    } catch (err) {
      fail(err);
    }
  }, [askText, fail]);

  const renameLibrary = useCallback(async (library) => {
    const name = await askText('知识库改名', library.name);
    if (!name || name === library.name) return;
    try {
      const data = await api.updateLibrary(library.id, { name });
      setLibraries((current) => current.map((l) => (l.id === data.library.id ? data.library : l)));
    } catch (err) {
      fail(err);
    }
  }, [askText, fail]);

  const removeLibrary = useCallback(async (library) => {
    const ok = await askConfirm(`删除知识库「${library.name}」？管理的库会移进回收站，挂载的库只取消挂载。`);
    if (!ok) return;
    try {
      // 挂载库不能带 files=1（Host 会 400），管理的库才连文件一起进回收站。
      await api.deleteLibrary(library.id, library.kind === 'managed');
      const next = libraries.filter((l) => l.id !== library.id);
      setLibraries(next);
      setActiveId(next[0]?.id || '');
    } catch (err) {
      fail(err);
    }
  }, [libraries, askConfirm, fail]);

  const mountLibrary = useCallback(async () => {
    const path = await askText('挂载目录（绝对路径，支持 ~）', '~/Documents/notes');
    if (!path) return;
    try {
      const data = await api.createLibrary({ name: path.split('/').filter(Boolean).pop() || '挂载库', path, kind: 'mounted' });
      setLibraries((current) => [...current, data.library]);
      setActiveId(data.library.id);
    } catch (err) {
      fail(err);
    }
  }, [askText, fail]);

  const moveLibrary = useCallback(async (id, delta) => {
    const index = libraries.findIndex((l) => l.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= libraries.length) return;
    const next = [...libraries];
    [next[index], next[target]] = [next[target], next[index]];
    setLibraries(next);
    try {
      await api.reorderLibraries(next.map((l) => l.id));
    } catch (err) {
      fail(err);
    }
  }, [libraries, fail]);

  // ── 文档操作 ───────────────────────────────────────────
  const newDoc = useCallback(async (dir = '') => {
    if (!activeId) return;
    const name = await askText('新建文档', '未命名');
    if (!name) return;
    try {
      const data = await api.createDoc({ library: activeId, dir, name });
      await refreshTree(activeId);
      await openDoc(data.relPath, activeId);
    } catch (err) {
      fail(err);
    }
  }, [activeId, refreshTree, openDoc, askText, fail]);

  const newFolder = useCallback(async (dir = '') => {
    if (!activeId) return;
    const name = await askText('新建文件夹', '新文件夹');
    if (!name) return;
    try {
      const prefix = dir ? dir.replace(/\/+$/, '') + '/' : '';
      await api.mkdir({ library: activeId, dir: prefix + name });
      await refreshTree(activeId);
    } catch (err) {
      fail(err);
    }
  }, [activeId, refreshTree, askText, fail]);

  const moveEntry = useCallback(async (from, to) => {
    if (!activeId || !from || from === to) return;
    try {
      await api.moveDoc({ library: activeId, from, to });
      await refreshTree(activeId);
      if (doc?.relPath === from) await openDoc(to);
    } catch (err) {
      fail(err);
    }
  }, [activeId, refreshTree, doc, openDoc, fail]);

  const deleteEntry = useCallback(async (relPath) => {
    if (!activeId) return;
    if (!(await askConfirm(`把「${relPath}」移进回收站？`))) return;
    try {
      await api.deleteDoc(activeId, relPath);
      await refreshTree(activeId);
      if (doc?.relPath === relPath) { setDoc(null); setNotes([]); }
    } catch (err) {
      fail(err);
    }
  }, [activeId, refreshTree, doc, askConfirm, fail]);

  // ── 导入导出 ───────────────────────────────────────────
  const importFiles = useCallback(async (fileList, dir = '') => {
    if (!activeId || !fileList?.length) return;
    if (!fileList.some((file) => /\.(md|markdown|txt)$/i.test(file.name || ''))) {
      toast('只支持导入 .md / .markdown / .txt');
      return;
    }
    try {
      setBusy(`导入 ${fileList.length} 个文件…`);
      const files = [];
      for (const file of fileList) {
        const relPath = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
        if (!/\.(md|markdown|txt)$/i.test(relPath)) continue;
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < buffer.length; i += chunk) {
          binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
        }
        files.push({ relPath, contentBase64: btoa(binary), mtimeMs: file.lastModified });
      }
      const data = await api.importFiles({ library: activeId, dir, files });
      await refreshTree(activeId);
      const written = data.written?.length ?? 0;
      const skipped = data.skipped?.length ?? 0;
      toast(skipped > 0 ? `导入 ${written} 个，跳过 ${skipped} 个（已存在）` : `导入 ${written} 个文件`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  }, [activeId, refreshTree, toast, fail]);

  const onPickFiles = useCallback((event) => {
    // FileList 是活对象：先拷成数组再清 value，否则 await 之后后面几个文件就取不到了。
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void importFiles(files);
  }, [importFiles]);

  const onPickFolder = useCallback((event) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void importFiles(files);
  }, [importFiles]);

  const exportLibrary = useCallback(async () => {
    if (!activeId) return;
    try {
      setBusy('打包中…');
      const response = await fetch(api.exportUrl(activeId));
      if (!response.ok) throw new Error('导出失败（' + response.status + '）');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (active?.name || 'knowledge-base') + '.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('已导出 zip');
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  }, [activeId, active, toast, fail]);

  const pickRole = useCallback(async (role) => {
    try {
      // 角色提示词读的是磁盘正文，先把当前编辑落盘，会话才看得到最新的内容。
      if (latest.current.dirty) await doSave();
      const data = await api.roleContext({ roleId: role.id, library: activeId, path: doc?.relPath || '' });
      onStartRole?.(data, { role, doc: doc?.relPath || '', library: active?.name || '' });
    } catch (err) {
      fail(err);
    }
  }, [activeId, doc, active, onStartRole, fail, doSave]);

  // 笔记锚点只在当前编辑器实例里可靠；blockId 失效时按块文本回退，仍找不到就静默不动。
  const locate = useCallback((note) => {
    if (!doc || mode === 'source') return;
    focusBlock(editorRef.current, note.anchor);
  }, [doc, mode]);

  const filteredTree = tree;

  return (
    <div className="rag-root">
      <style data-plugin="dsh-rag">{RAG_CSS}</style>

      <aside className="rag-rail">
        <div className="rag-rail-head">
          <span className="rag-title">知识库</span>
          <div className="rag-rail-actions">
            <button type="button" className="rag-btn rag-btn-ghost" onClick={createLibrary} title="新建知识库">＋ 新建</button>
            <button type="button" className="rag-btn rag-btn-ghost" onClick={mountLibrary} title="挂载已有目录">挂载</button>
          </div>
        </div>

        <div className="rag-libs">
          {libraries.map((library, index) => (
            <div
              key={library.id}
              className={'rag-lib' + (library.id === activeId ? ' is-active' : '')}
              onClick={() => setActiveId(library.id)}
            >
              <span className="rag-lib-name" title={library.path}>{library.name}</span>
              <span className="rag-lib-count">{library.docCount ?? ''}</span>
              <span className="rag-lib-tools" onClick={(e) => e.stopPropagation()}>
                <button type="button" onClick={() => moveLibrary(library.id, -1)} title="上移" disabled={index === 0}>↑</button>
                <button type="button" onClick={() => moveLibrary(library.id, 1)} title="下移" disabled={index === libraries.length - 1}>↓</button>
                <button type="button" onClick={() => renameLibrary(library)} title="改名">✎</button>
                <button type="button" onClick={() => removeLibrary(library)} title="删除">✕</button>
              </span>
            </div>
          ))}
          {libraries.length === 0 && <p className="rag-empty">还没有知识库，点「＋ 新建」。</p>}
        </div>

        <div className="rag-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索当前库…"
            aria-label="搜索知识库"
          />
        </div>

        {hits !== null ? (
          <div className="rag-hits">
            <div className="rag-hits-head">
              <span>{hits.length} 条命中</span>
              <button type="button" className="rag-link" onClick={() => setQuery('')}>清除</button>
            </div>
            {hits.map((hit, index) => (
              <button
                key={`${hit.libraryId}:${hit.relPath}:${index}`}
                type="button"
                className="rag-hit"
                onClick={() => { setActiveId(hit.libraryId); void openDoc(hit.relPath, hit.libraryId); setQuery(''); }}
              >
                <span className="rag-hit-title">{hit.title || hit.relPath}</span>
                <span className="rag-hit-path">{hit.libraryName} / {hit.relPath}</span>
                <span className="rag-hit-excerpt">{hit.excerpt}</span>
              </button>
            ))}
            {hits.length === 0 && <p className="rag-empty">没有命中。</p>}
          </div>
        ) : (
          <div className="rag-tree-wrap">
            <div className="rag-tree-actions">
              <button type="button" className="rag-btn rag-btn-ghost" onClick={() => newDoc('')}>＋ 文档</button>
              <button type="button" className="rag-btn rag-btn-ghost" onClick={() => newFolder('')}>＋ 文件夹</button>
              <label className="rag-btn rag-btn-ghost">
                导入
                <input type="file" multiple accept=".md,.markdown,.txt" onChange={onPickFiles} hidden />
              </label>
              <label className="rag-btn rag-btn-ghost" title="导入整个文件夹">
                目录
                <input type="file" multiple webkitdirectory="" directory="" onChange={onPickFolder} hidden />
              </label>
              <button type="button" className="rag-btn rag-btn-ghost" onClick={exportLibrary} disabled={!activeId}>导出</button>
            </div>

            <div
              className={'rag-tree' + (dropTarget === '__root__' ? ' is-drop' : '')}
              onDragOver={(e) => { if (dragging) { e.preventDefault(); setDropTarget('__root__'); } }}
              onDragLeave={() => setDropTarget((t) => (t === '__root__' ? '' : t))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget('');
                if (dragging) moveEntry(dragging, dragging.split('/').pop());
                setDragging('');
              }}
            >
              {filteredTree.map((node) => (
                <TreeNode
                  key={node.relPath}
                  node={node}
                  depth={0}
                  activePath={doc?.relPath || ''}
                  dragging={dragging}
                  dropTarget={dropTarget}
                  onOpen={openDoc}
                  onDelete={deleteEntry}
                  onDragStart={setDragging}
                  onDragOver={setDropTarget}
                  onDropEntry={(from, toDir) => {
                    const name = from.split('/').pop();
                    moveEntry(from, toDir ? toDir + '/' + name : name);
                  }}
                />
              ))}
              {filteredTree.length === 0 && activeId && <p className="rag-empty">这个库还是空的。</p>}
              {!activeId && <p className="rag-empty">选一个知识库，或新建一个。</p>}
            </div>
          </div>
        )}
      </aside>

      <main className="rag-main">
        <header className="rag-main-head">
          <div className="rag-crumbs">
            {active ? <span className="rag-chip">{active.name}</span> : <span className="rag-chip">未选库</span>}
            {doc && <span className="rag-crumb-path">{doc.relPath}</span>}
          </div>
          <div className="rag-main-actions">
            {doc && (
              <div className="rag-seg">
                <button type="button" className={mode === 'rich' ? 'is-on' : ''} onClick={() => setMode('rich')}>富文本</button>
                <button type="button" className={mode === 'source' ? 'is-on' : ''} onClick={() => setMode('source')}>源码</button>
              </div>
            )}
            {doc && <button type="button" className="rag-btn" onClick={beginNote}>＋ 笔记</button>}
            {doc && <button type="button" className="rag-btn rag-btn-primary" onClick={() => flushSave(latest.current.conflict)}>保存</button>}
          </div>
        </header>

        {error && (
          <div className="rag-banner is-error">
            <span>{error}</span>
            <button type="button" className="rag-link" onClick={() => setError('')}>关闭</button>
          </div>
        )}
        {(notice || busy) && <div className="rag-banner">{busy || notice}</div>}

        <div className="rag-doc">
          {!doc && (
            <div className="rag-blank">
              <h2>选一篇文档开始</h2>
              <p>左边建库、建文件夹、导入 md；右边写正文，随时叫角色来一起看。</p>
            </div>
          )}
          {doc && mode === 'rich' && (
            <MarkdownEditor
              key={`${activeId}:${doc.relPath}`}
              markdown={doc.markdown}
              onChange={handleChange}
              onReady={(editor) => { editorRef.current = editor; }}
            />
          )}
          {doc && mode === 'source' && (
            <textarea
              className="rag-source"
              value={doc.markdown}
              onChange={(e) => handleChange(e.target.value)}
              spellCheck={false}
            />
          )}
        </div>
      </main>

      <aside className="rag-side">
        <div className="rag-side-block">
          <div className="rag-side-head">
            <span>笔记</span>
            {doc && <button type="button" className="rag-link" onClick={beginNote}>加一条</button>}
          </div>
          {draftNote && (
            <div className="rag-note is-draft">
              {draftNote.anchor?.quote && <p className="rag-note-quote">「{draftNote.anchor.quote.slice(0, 80)}」</p>}
              <textarea
                autoFocus
                value={draftNote.text}
                placeholder="写点什么…（⌘↩ 保存）"
                onChange={(e) => setDraftNote({ ...draftNote, text: e.target.value })}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commitNote();
                  if (e.key === 'Escape') setDraftNote(null);
                }}
              />
              <div className="rag-note-actions">
                <button type="button" className="rag-btn rag-btn-primary" onClick={commitNote}>保存</button>
                <button type="button" className="rag-btn" onClick={() => setDraftNote(null)}>取消</button>
              </div>
            </div>
          )}
          <div className="rag-notes">
            {notes.map((note) => (
              <div key={note.id} className="rag-note">
                <p className="rag-note-quote" onClick={() => locate(note)}>
                  {note.anchor?.quote || '（块的笔记）'}
                </p>
                <p className="rag-note-text">{note.text}</p>
                <div className="rag-note-actions">
                  <button type="button" className="rag-link" onClick={() => locate(note)}>定位</button>
                  <button type="button" className="rag-link" onClick={() => removeNote(note.id)}>删除</button>
                </div>
              </div>
            ))}
            {notes.length === 0 && !draftNote && <p className="rag-empty">{doc ? '这篇还没有笔记。' : '打开一篇文档再加笔记。'}</p>}
          </div>
        </div>

        <div className="rag-side-block">
          <div className="rag-side-head">
            <span>角色</span>
            <button
              type="button"
              className="rag-link"
              onClick={async () => {
                const name = await askText('新建角色', '');
                if (!name) return;
                const instructions = await askText(`「${name}」怎么跟你说话？（提示词）`, '');
                if (!instructions) return;
                try {
                  const data = await api.saveRole({ name, prompt: instructions });
                  setRoles((current) => [...current.filter((r) => r.id !== data.role.id), data.role]);
                } catch (err) {
                  fail(err);
                }
              }}
            >新建</button>
          </div>
          <div className="rag-roles">
            {roles.map((role) => (
              <button key={role.id} type="button" className="rag-role" onClick={() => pickRole(role)} title={role.description}>
                <span className="rag-role-name">{role.name}</span>
                <span className="rag-role-desc">{role.description}</span>
              </button>
            ))}
            {roles.length === 0 && <p className="rag-empty">没有角色。</p>}
          </div>
          <p className="rag-hint">点角色会开一个带它人格的新会话，并把当前文档位置带过去。</p>
        </div>
      </aside>
      {dialog && (
        <PromptDialog
          dialog={dialog}
          onCancel={() => settleDialog(null)}
          onOk={(value) => settleDialog(value)}
        />
      )}
    </div>
  );
}

/**
 * 极简应用内对话框：text 输入（返回字符串或 null）、confirm（返回 true/false）。
 * 不用 window.prompt/confirm —— 桌面端 prompt 不存在，confirm 也会阻塞渲染进程。
 */
function PromptDialog({ dialog, onOk, onCancel }) {
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

function TreeNode({ node, depth, activePath, dragging, dropTarget, onOpen, onDelete, onDragStart, onDragOver, onDropEntry }) {
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
      <span className="rag-dot" />
      <span className="rag-name" title={node.relPath}>{node.name}</span>
      <span className="rag-row-tools" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => onDelete(node.relPath)} title="删除">✕</button>
      </span>
    </div>
  );
}

function newNoteId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const RAG_CSS = `
.rag-root{display:grid;grid-template-columns:264px minmax(0,1fr) 300px;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-text-primary,#1a1a1a);font-size:13px}
.rag-root *{box-sizing:border-box}
.rag-rail,.rag-side{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));overflow:hidden}
.rag-side{border-right:none;border-left:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));overflow-y:auto;padding:4px 0 24px}
.rag-rail-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 6px}
.rag-title{font-weight:600;font-size:14px}
.rag-rail-actions{display:flex;gap:4px}
.rag-btn{border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));background:transparent;color:inherit;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer}
.rag-btn:hover{background:rgba(0,0,0,.04)}
.rag-btn:disabled{opacity:.4;cursor:default}
.rag-btn-primary{background:var(--dsw-alias-accent,#2f6bff);border-color:transparent;color:#fff}
.rag-btn-ghost{border-color:transparent}
.rag-link{border:none;background:none;color:var(--dsw-alias-accent,#2f6bff);cursor:pointer;font-size:12px;padding:0 2px}
.rag-libs{max-height:34%;overflow-y:auto;padding:2px 6px}
.rag-lib{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer}
.rag-lib:hover{background:rgba(0,0,0,.03)}
.rag-lib.is-active{background:rgba(47,107,255,.1)}
.rag-lib-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rag-lib-count{font-size:11px;opacity:.5}
.rag-lib-tools{display:none;gap:2px}
.rag-lib:hover .rag-lib-tools{display:flex}
.rag-lib-tools button{border:none;background:none;cursor:pointer;opacity:.6;font-size:11px;padding:0 2px;color:inherit}
.rag-search{padding:6px 10px}
.rag-search input{width:100%;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));background:transparent;color:inherit;border-radius:6px;padding:5px 8px;font-size:12px}
.rag-tree-actions{display:flex;flex-wrap:wrap;gap:2px;padding:0 8px 6px}
.rag-tree{flex:1;overflow-y:auto;padding:0 6px}
.rag-tree-wrap{display:flex;flex-direction:column;min-height:0;flex:1}
.rag-tree.is-drop{outline:1px dashed var(--dsw-alias-accent,#2f6bff);outline-offset:-2px;border-radius:6px}
.rag-row{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;cursor:pointer;user-select:none}
.rag-row:hover{background:rgba(0,0,0,.04)}
.rag-row.is-active{background:rgba(47,107,255,.12)}
.rag-row.is-drop{background:rgba(47,107,255,.18)}
.rag-caret{width:10px;font-size:10px;opacity:.6}
.rag-dot{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.3;margin-left:4px}
.rag-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rag-row-tools{display:none}
.rag-row:hover .rag-row-tools{display:block}
.rag-row-tools button{border:none;background:none;cursor:pointer;opacity:.5;color:inherit;font-size:11px}
.rag-hits{flex:1;overflow-y:auto;padding:0 8px}
.rag-hits-head{display:flex;justify-content:space-between;font-size:11px;opacity:.6;padding:2px 4px 6px}
.rag-hit{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;border:none;background:transparent;color:inherit;padding:6px 8px;border-radius:6px;cursor:pointer}
.rag-hit:hover{background:rgba(0,0,0,.04)}
.rag-hit-title{font-weight:600}
.rag-hit-path{font-size:11px;opacity:.55}
.rag-hit-excerpt{font-size:11px;opacity:.75;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rag-main{display:flex;flex-direction:column;min-width:0;min-height:0}
.rag-main-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08))}
.rag-crumbs{display:flex;align-items:center;gap:8px;min-width:0}
.rag-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.05)}
.rag-crumb-path{font-size:12px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rag-main-actions{display:flex;gap:6px;align-items:center}
.rag-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));border-radius:6px;overflow:hidden}
.rag-seg button{border:none;background:transparent;color:inherit;padding:3px 8px;font-size:12px;cursor:pointer}
.rag-seg button.is-on{background:rgba(47,107,255,.12)}
.rag-banner{padding:6px 16px;font-size:12px;background:rgba(47,107,255,.08)}
.rag-banner.is-error{background:rgba(220,38,38,.1);display:flex;justify-content:space-between}
.rag-doc{flex:1;min-height:0;overflow:auto}
.rag-blank{padding:60px 40px;opacity:.7}
.rag-blank h2{font-size:16px;margin:0 0 8px}
.rag-editor-shell{padding:16px 24px 120px}
.rag-source{width:100%;height:100%;min-height:400px;border:none;outline:none;resize:none;padding:16px 24px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.6;background:transparent;color:inherit}
.rag-side-block{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06))}
.rag-side-head{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px}
.rag-notes{display:flex;flex-direction:column;gap:8px}
.rag-note{border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.1));border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.rag-note.is-draft{background:rgba(47,107,255,.05)}
.rag-note textarea{width:100%;min-height:56px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));border-radius:6px;background:transparent;color:inherit;font-size:12px;padding:6px;resize:vertical}
.rag-note-quote{font-size:12px;opacity:.8;border-left:2px solid rgba(0,0,0,.1);padding-left:6px;margin:0;cursor:pointer}
.rag-note-text{margin:0;white-space:pre-wrap}
.rag-note-actions{display:flex;gap:8px}
.rag-roles{display:flex;flex-direction:column;gap:6px}
.rag-role{display:flex;flex-direction:column;gap:2px;text-align:left;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.1));background:transparent;color:inherit;border-radius:8px;padding:8px 10px;cursor:pointer}
.rag-role:hover{background:rgba(47,107,255,.06)}
.rag-role-name{font-weight:600}
.rag-role-desc{font-size:11px;opacity:.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rag-hint{font-size:11px;opacity:.55;margin:6px 0 0}
.rag-empty{font-size:12px;opacity:.55;padding:6px 8px;margin:0}
.rag-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:80}
.rag-modal{width:min(420px,86vw);background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-text-primary,inherit);border-radius:12px;padding:16px 18px;box-shadow:0 18px 48px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:12px;font-size:13px}
.rag-modal-title{margin:0;font-weight:600;line-height:1.5}
.rag-modal-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.18));border-radius:8px;padding:8px 10px;font-size:13px;background:transparent;color:inherit;outline:none}
.rag-modal-input:focus{border-color:rgba(47,107,255,.6)}
.rag-modal-actions{display:flex;justify-content:flex-end;gap:8px}
`;

export default RagPage;
