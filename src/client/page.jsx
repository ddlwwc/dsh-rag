import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, errorText } from './api.js';
import { MarkdownEditor, currentAnchor, focusBlock, resolveAnchor } from './blocknote.jsx';
import { PromptDialog } from './dialog.jsx';
import { TreeNode } from './tree.jsx';
import { RAG_CSS } from './styles.js';
import { applyThemeVars, fileToBase64, newNoteId, observeTheme, openFullscreenWindow, readThemeName } from './helpers.js';
import { LibraryIcon } from './icons.jsx';

const SAVE_DELAY = 900;

// 栏位折叠状态存本地：纯界面偏好，不该混进知识库数据。
const FLAG_PREFIX = 'dsh-rag:';
function readFlag(name) {
  try { return localStorage.getItem(FLAG_PREFIX + name) === '1'; } catch { return false; }
}
function writeFlag(name, value) {
  try { localStorage.setItem(FLAG_PREFIX + name, value ? '1' : '0'); } catch {}
}

export function RagPage({ ctx, onStartRole, onCloseFullscreen = null }) {
  const [libraries, setLibraries] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [tree, setTree] = useState([]);
  const [doc, setDoc] = useState(null);
  // 宿主缓存的块 JSON（mtime 一致才给），命中就省掉一次整篇 markdown 解析。
  const [docBlocks, setDocBlocks] = useState(null);
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
  // 多选导出的集合；空集合时「导出」就是整库。
  const [selected, setSelected] = useState(() => new Set());
  // 笔记锚点在当前文档里的存活情况：只有 missing 会在笔记卡里标一行小字，绝不弹横幅。
  const [noteStatus, setNoteStatus] = useState({});
  const [editorReady, setEditorReady] = useState(false);
  const [themeName, setThemeName] = useState(readThemeName);
  // 文档在别处（外部编辑器/同步工具）被改过：只在标题栏放一颗小按钮，不弹任何横幅。
  const [external, setExternal] = useState(false);
  // 检索结果 → 角色：选中角色后带着这批命中片段开会话。
  const [rolePickFor, setRolePickFor] = useState('');
  // 窄窗口下右侧笔记栏变成抽屉，靠这个开关拉出来。
  const [sideOpen, setSideOpen] = useState(false);
  // 左右两栏可整块收起：把编辑区让出来，状态记在本地，下次打开还是这个样子。
  const [railCollapsed, setRailCollapsed] = useState(() => readFlag('rail-collapsed'));
  const [sideCollapsed, setSideCollapsed] = useState(() => readFlag('side-collapsed'));
  // 浏览器拦了新窗口时的页内兜底。
  const [inlineFull, setInlineFull] = useState(false);
  const fullRef = useRef(null);

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

  /**
   * 全屏：开一个独立窗口，把知识库这一页整个搬进去（不带 DSH 外壳）。
   * 窗口被拦时退回页内全屏 —— 点了至少得有点反应。
   */
  const openFullscreen = useCallback(() => {
    const existing = fullRef.current;
    if (existing && !existing.closed) { existing.focus(); return; }
    const win = openFullscreenWindow('知识库');
    if (!win) {
      setInlineFull(true);
      toast('新窗口被浏览器拦了，已切到页内全屏');
      return;
    }
    const host = win.document.createElement('div');
    host.style.height = '100%';
    win.document.body.appendChild(host);
    const root = createRoot(host);
    const close = () => {
      try { root.unmount(); } catch {}
      if (!win.closed) win.close();
      if (fullRef.current === win) fullRef.current = null;
    };
    fullRef.current = win;
    win.addEventListener('beforeunload', () => { if (fullRef.current === win) fullRef.current = null; });
    root.render(<RagPage ctx={ctx} onStartRole={onStartRole} onCloseFullscreen={close} />);
  }, [ctx, onStartRole, toast]);

  // 跟住宿主主题：用户切深色时编辑器要跟着切，不然白底会刺眼。
  useEffect(() => observeTheme(setThemeName), []);
  useEffect(() => { writeFlag('rail-collapsed', railCollapsed); }, [railCollapsed]);
  useEffect(() => { writeFlag('side-collapsed', sideCollapsed); }, [sideCollapsed]);
  // 宿主换主题时，独立窗口里的知识库也得跟着换（那边是另一份 CSS 变量快照）。
  useEffect(() => {
    const win = fullRef.current;
    if (win && !win.closed) applyThemeVars(win.document);
  }, [themeName]);
  // 关掉主窗口时顺手把独立窗口一起收走，不留孤儿进程。
  useEffect(() => () => {
    const win = fullRef.current;
    if (win && !win.closed) win.close();
  }, []);

  /**
   * 正文里贴图/拖图时由编辑器回调到这里。Host 负责落盘（七牛或本地 _assets/），
   * 返回能直接写进 markdown 的 URL —— 客户端永远不碰 AK/SK。
   */
  const uploadAsset = useCallback(async (file) => {
    if (!activeId) throw new Error('先选一个知识库再插图');
    const contentBase64 = await fileToBase64(file);
    const data = await api.upload({
      library: activeId,
      name: file.name || 'image.png',
      mime: file.type || 'image/png',
      contentBase64,
    });
    return data.url;
  }, [activeId]);

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
    setDocBlocks(null);
    setNotes([]);
    setHits(null);
    setNoteStatus({});
    setEditorReady(false);
    latest.current = { markdown: '', dirty: false, conflict: false };
    if (!activeId) { setTree([]); return; }
    refreshTree(activeId);
  }, [activeId, refreshTree]);

  /**
   * 文档或笔记变了之后重新判一次锚点。判定失败**不提示**（用户明确要求过），
   * 只在对应的笔记卡里标一行灰字，让用户知道这条笔记指的位置可能不对了。
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editorReady || !editor || notes.length === 0) { setNoteStatus({}); return; }
    const next = {};
    for (const note of notes) {
      const { status } = resolveAnchor(editor, note.anchor);
      if (status === 'missing') next[note.id] = 'missing';
      else if (status === 'shifted') next[note.id] = 'shifted';
    }
    setNoteStatus(next);
  }, [notes, editorReady, doc?.relPath]);

  // ── 外部改动探测 ───────────────────────────────────────
  // 不读正文、只比 mtime：20 秒一轮 + 窗口重新聚焦时各查一次，开销可以忽略。
  useEffect(() => {
    if (!doc || !activeId) { setExternal(false); return; }
    let alive = true;
    const check = async () => {
      if (!alive || latest.current.dirty) return;
      try {
        const stat = await api.docStat(activeId, doc.relPath);
        if (!alive) return;
        setExternal(!stat.exists || Math.abs((stat.mtimeMs || 0) - (doc.mtimeMs || 0)) > 1);
      } catch {
        // 探测失败就当没变，别打扰用户
      }
    };
    const timer = window.setInterval(check, 20000);
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [activeId, doc?.relPath, doc?.mtimeMs]);

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
      // 顺手把块 JSON 回填进索引缓存：下次打开这篇就不用再解析一遍 markdown。
      // 失败无所谓，最坏是下次多解析一次，绝不能因为它影响保存。
      const editor = editorRef.current;
      if (editor) {
        void api.saveDocBlocks({
          library: activeId,
          path: doc.relPath,
          mtimeMs: saved.saved.mtimeMs,
          blocks: editor.document,
        }).catch(() => {});
      }
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
      setDocBlocks(Array.isArray(data.blocks) ? data.blocks : null);
      setNotes(data.doc.notes || []);
      setDraftNote(null);
      setError('');
      setExternal(false);
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
      if (doc?.relPath === relPath) { setDoc(null); setDocBlocks(null); setNotes([]); }
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

  const exportLibrary = useCallback(async (paths = []) => {
    if (!activeId) return;
    try {
      setBusy('打包中…');
      const response = await fetch(api.exportUrl(activeId, paths));
      if (!response.ok) throw new Error('导出失败（' + response.status + '）');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (active?.name || 'knowledge-base') + (paths.length > 0 ? '-选中' : '') + '.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(paths.length > 0 ? `已导出 ${paths.length} 项` : '已导出 zip');
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  }, [activeId, active, toast, fail]);

  const toggleSelect = useCallback((relPath) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(relPath)) next.delete(relPath); else next.add(relPath);
      return next;
    });
  }, []);

  const exportSelected = useCallback(() => {
    if (selected.size === 0) return;
    void exportLibrary([...selected]);
  }, [selected, exportLibrary]);

  const pickRole = useCallback(async (role, options = {}) => {
    try {
      // 角色提示词读的是磁盘正文，先把当前编辑落盘，会话才看得到最新的内容。
      if (latest.current.dirty) await doSave();
      const data = await api.roleContext({
        roleId: role.id,
        library: activeId,
        path: options.query ? '' : (doc?.relPath || ''),
        query: options.query || '',
      });
      onStartRole?.(data, { role, doc: options.query ? '' : (doc?.relPath || ''), library: active?.name || '' });
    } catch (err) {
      fail(err);
    }
  }, [activeId, doc, active, onStartRole, fail, doSave]);

  /** 重载当前文档：本地有未保存改动时先问一句，避免直接丢掉。 */
  const reloadDoc = useCallback(async () => {
    if (!doc) return;
    if (latest.current.dirty && !(await askConfirm('本地还有未保存的改动，重载会丢掉它们。继续？'))) return;
    setExternal(false);
    await openDoc(doc.relPath);
  }, [doc, askConfirm, openDoc]);

  // 笔记锚点只在当前编辑器实例里可靠；blockId 失效时按块文本回退，仍找不到就静默不动。
  const locate = useCallback((note) => {
    if (!doc || mode !== 'rich') { toast('切回富文本才能定位到块'); return; }
    const { status, placed } = focusBlock(editorRef.current, note.anchor);
    if (!placed) toast('这块内容已经不在原位了');
    else if (status !== 'exact') setNoteStatus((current) => ({ ...current, [note.id]: status }));
  }, [doc, mode, toast]);

  // ── 角色 ───────────────────────────────────────────────
  const saveRole = useCallback(async (role, patch) => {
    const next = { id: role?.id, emoji: role?.emoji, description: role?.description, ...patch };
    try {
      const data = await api.saveRole(next);
      setRoles((current) => {
        const rest = current.filter((r) => r.id !== data.role.id);
        return [...rest, data.role].sort((a, b) => Number(b.builtin) - Number(a.builtin));
      });
      toast('角色已保存');
    } catch (err) {
      fail(err);
    }
  }, [toast, fail]);

  const removeRole = useCallback(async (role) => {
    if (!(await askConfirm(`删除角色「${role.name}」？已经开出去的会话不受影响。`))) return;
    try {
      await api.deleteRole(role.id);
      setRoles((current) => current.filter((r) => r.id !== role.id));
    } catch (err) {
      fail(err);
    }
  }, [askConfirm, fail]);

  const rootClass = [
    'rag-root',
    railCollapsed ? 'is-rail-collapsed' : '',
    sideCollapsed ? 'is-side-collapsed' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={rootClass}>
      <style data-plugin="dsh-rag">{RAG_CSS}</style>

      <aside className="rag-rail">
        <div className="rag-rail-head">
          <span className="rag-title">知识库</span>
          <div className="rag-rail-actions">
            <button type="button" className="rag-btn rag-btn-ghost" onClick={createLibrary} title="新建知识库">＋ 新建</button>
            <button type="button" className="rag-btn rag-btn-ghost" onClick={mountLibrary} title="挂载已有目录">挂载</button>
            <button
              type="button"
              className="rag-icon-btn"
              onClick={() => setRailCollapsed(true)}
              title="收起知识库栏"
              aria-label="收起知识库栏"
            >‹</button>
          </div>
        </div>

        <div className="rag-libs">
          {libraries.map((library, index) => (
            <div
              key={library.id}
              className={'rag-lib' + (library.id === activeId ? ' is-active' : '')}
              onClick={() => setActiveId(library.id)}
            >
              <LibraryIcon />
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
              <span className="rag-hits-tools">
                {hits.length > 0 && (
                  <button
                    type="button"
                    className="rag-link"
                    onClick={() => setRolePickFor((current) => (current ? '' : '__pick__'))}
                  >用角色研究</button>
                )}
                <button type="button" className="rag-link" onClick={() => { setQuery(''); setRolePickFor(''); }}>清除</button>
              </span>
            </div>
            {rolePickFor && (
              <div className="rag-role-pick">
                {roles.map((role) => (
                  <button
                    key={role.id}
                    type="button"
                    className="rag-role-chip"
                    onClick={() => { setRolePickFor(''); pickRole(role, { query: query.trim() }); }}
                  >{role.emoji ? role.emoji + ' ' : ''}{role.name}</button>
                ))}
                {roles.length === 0 && <p className="rag-empty">还没有角色。</p>}
              </div>
            )}
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
              <button type="button" className="rag-btn rag-btn-ghost" onClick={() => exportLibrary([])} disabled={!activeId}>导出整库</button>
              <button type="button" className="rag-btn rag-btn-ghost" onClick={exportSelected} disabled={selected.size === 0}>导出选中{selected.size > 0 ? `(${selected.size})` : ''}</button>
              {selected.size > 0 && (
                <button type="button" className="rag-btn rag-btn-ghost" onClick={() => setSelected(new Set())}>清空选择</button>
              )}
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
              {tree.map((node) => (
                <TreeNode
                  key={node.relPath}
                  node={node}
                  depth={0}
                  activePath={doc?.relPath || ''}
                  dragging={dragging}
                  dropTarget={dropTarget}
                  selected={selected}
                  onToggleSelect={toggleSelect}
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
              {tree.length === 0 && activeId && <p className="rag-empty">这个库还是空的。</p>}
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
            {doc && external && (
              <button
                type="button"
                className="rag-chip rag-chip-warn"
                title="文件在磁盘上被改过（外部编辑器或同步工具），点这里重新载入"
                onClick={reloadDoc}
              >已在外部修改 · 重载</button>
            )}
          </div>
          <div className="rag-main-actions">
            {doc && (
              <div className="rag-seg">
                <button type="button" className={mode === 'rich' ? 'is-on' : ''} onClick={() => setMode('rich')}>富文本</button>
                <button type="button" className={mode === 'source' ? 'is-on' : ''} onClick={() => setMode('source')}>源码</button>
              </div>
            )}
            {doc && <button type="button" className="rag-btn" onClick={beginNote}>＋ 笔记</button>}
            {railCollapsed && (
              <button type="button" className="rag-btn" onClick={() => setRailCollapsed(false)} title="展开知识库栏">库栏</button>
            )}
            {sideCollapsed && (
              <button type="button" className="rag-btn" onClick={() => setSideCollapsed(false)} title="展开笔记栏">笔记栏</button>
            )}
            <button type="button" className="rag-btn rag-side-toggle" onClick={() => setSideOpen((v) => !v)} title="笔记与角色">侧栏</button>
            {onCloseFullscreen ? (
              <button type="button" className="rag-btn" onClick={() => onCloseFullscreen()} title="关闭这个全屏窗口">退出全屏</button>
            ) : (
              <button type="button" className="rag-btn" onClick={openFullscreen} title="在新窗口里看知识库（全屏）">⤢ 全屏</button>
            )}
            {doc && <button type="button" className="rag-btn rag-btn-primary" onClick={() => flushSave(latest.current.conflict)}>保存</button>}
          </div>
        </header>

        {error && (
          <div className="rag-banner is-error">
            <span>{error}</span>
            <button type="button" className="rag-link" onClick={() => setError('')}>关闭</button>
          </div>
        )}
        {/* 状态提示浮在右下角，不占文档流的行高 —— 否则每保存一次正文就会上下跳一下。 */}
        {(notice || busy) && <div className="rag-toast" role="status">{busy || notice}</div>}

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
              blocks={docBlocks}
              theme={themeName}
              onChange={handleChange}
              onUpload={uploadAsset}
              onReady={(editor) => { editorRef.current = editor; setEditorReady(Boolean(editor)); }}
            />
          )}
          {doc && mode === 'source' && (
            <div className="rag-source">
              <div className="rag-source-head">
                <span>markdown 源码（只读）</span>
                <button
                  type="button"
                  className="rag-link"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(doc.markdown || '');
                      toast('已复制');
                    } catch {
                      toast('复制失败，请手动选中');
                    }
                  }}
                >复制</button>
              </div>
              <pre className="rag-source-body">{doc.markdown}</pre>
            </div>
          )}
        </div>
      </main>

      <aside className={'rag-side' + (sideOpen ? ' is-open' : '')}>
        <div className="rag-side-bar">
          <span>笔记与角色</span>
          <button
            type="button"
            className="rag-icon-btn"
            onClick={() => setSideCollapsed(true)}
            title="收起笔记栏"
            aria-label="收起笔记栏"
          >›</button>
        </div>
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
                <p className="rag-note-quote" onClick={() => locate(note)} title="点一下跳到这一块">
                  {note.anchor?.quote || '（块的笔记）'}
                  {note.anchor?.offset > 0 ? <span className="rag-note-offset">·第 {note.anchor.offset} 字</span> : null}
                </p>
                {noteStatus[note.id] === 'missing' && <p className="rag-note-drift">这块内容已经变了，原位置找不到了。</p>}
                {noteStatus[note.id] === 'shifted' && <p className="rag-note-drift">块内文字有改动，定位可能不准。</p>}
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
                  await saveRole(null, { name, prompt: instructions });
                } catch (err) {
                  fail(err);
                }
              }}
            >新建</button>
          </div>
          <div className="rag-roles">
            {roles.map((role) => (
              <div key={role.id} className="rag-role">
                <button type="button" className="rag-role-open" onClick={() => pickRole(role)} title={role.description}>
                  <span className="rag-role-name">{role.emoji ? role.emoji + ' ' : ''}{role.name}</span>
                  <span className="rag-role-desc">{role.description}</span>
                </button>
                {!role.builtin && (
                  <span className="rag-role-tools">
                    <button
                      type="button"
                      onClick={async () => {
                        const prompt = await askText(`「${role.name}」的提示词`, role.prompt || '');
                        if (prompt === null) return;
                        await saveRole(role, { prompt });
                      }}
                    >提示词</button>
                    <button type="button" onClick={() => removeRole(role)}>删除</button>
                  </span>
                )}
              </div>
            ))}
            {roles.length === 0 && <p className="rag-empty">没有角色。</p>}
          </div>
          <p className="rag-hint">点角色会开一个带它人格的新会话，并把当前文档位置带过去。</p>
        </div>
      </aside>
      {inlineFull && (
        <div className="rag-fullscreen">
          <RagPage ctx={ctx} onStartRole={onStartRole} onCloseFullscreen={() => setInlineFull(false)} />
        </div>
      )}
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

export default RagPage;
