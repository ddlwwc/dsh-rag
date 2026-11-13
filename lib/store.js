// dsh-rag — SQLite 存储层
//
// 只存两类东西：知识库登记表（libraries）与文档检索索引（docs + docs_fts）。
// 正文永远在磁盘上的 .md；笔记永远在侧车 .dsh.json。这里绝不做正文的第二真相。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
  library_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (library_id, rel_path)
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  library_id, rel_path, title, body, tokenize = 'trigram'
);
`;

export class Store {
  constructor(path) {
    this.path = path;
    this.db = null;
  }

  open() {
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec(SCHEMA);
    return this;
  }

  close() {
    try { this.db?.close(); } catch {}
    this.db = null;
  }

  // ---- libraries ----------------------------------------------------------

  listLibraries() {
    return this.db.prepare('SELECT * FROM libraries ORDER BY sort ASC, created_at ASC').all();
  }

  getLibrary(id) {
    return this.db.prepare('SELECT * FROM libraries WHERE id = ?').get(id) ?? null;
  }

  insertLibrary(row) {
    const now = Date.now();
    const sort = row.sort ?? (this.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM libraries').get().s);
    this.db.prepare(
      'INSERT INTO libraries (id, name, kind, path, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.name, row.kind, row.path, sort, now, now);
    return this.getLibrary(row.id);
  }

  updateLibrary(id, patch) {
    const current = this.getLibrary(id);
    if (!current) return null;
    this.db.prepare(
      'UPDATE libraries SET name = ?, path = ?, sort = ?, updated_at = ? WHERE id = ?',
    ).run(
      patch.name ?? current.name,
      patch.path ?? current.path,
      patch.sort ?? current.sort,
      Date.now(),
      id,
    );
    return this.getLibrary(id);
  }

  deleteLibrary(id) {
    this.db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM docs WHERE library_id = ?').run(id);
    this.db.prepare('DELETE FROM docs_fts WHERE library_id = ?').run(id);
  }

  reorderLibraries(ids) {
    const stmt = this.db.prepare('UPDATE libraries SET sort = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();
    ids.forEach((id, index) => stmt.run(index, now, id));
  }

  // ---- docs / search index ------------------------------------------------

  upsertDoc(libraryId, relPath, { size = 0, mtimeMs = 0, title = '', body = '' } = {}) {
    this.db.prepare(
      `INSERT INTO docs (library_id, rel_path, size, mtime_ms, title, body) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, rel_path) DO UPDATE SET
         size = excluded.size, mtime_ms = excluded.mtime_ms, title = excluded.title, body = excluded.body`,
    ).run(libraryId, relPath, size, mtimeMs, title, body);
    this.db.prepare('DELETE FROM docs_fts WHERE library_id = ? AND rel_path = ?').run(libraryId, relPath);
    this.db.prepare('INSERT INTO docs_fts (library_id, rel_path, title, body) VALUES (?, ?, ?, ?)')
      .run(libraryId, relPath, title, body);
  }

  removeDoc(libraryId, relPath) {
    this.db.prepare('DELETE FROM docs WHERE library_id = ? AND rel_path = ?').run(libraryId, relPath);
    this.db.prepare('DELETE FROM docs_fts WHERE library_id = ? AND rel_path = ?').run(libraryId, relPath);
  }

  /**
   * 删掉某个前缀下的所有文档 —— 必须带目录边界，否则删 `docs` 会把 `docs-old/x.md`
   * 一起干掉（`LIKE 'docs%'` 的经典坑）。
   */
  removeDocPrefix(libraryId, relPath) {
    const prefix = String(relPath || '').replaceAll('\\', '/').replace(/\/+$/, '');
    if (!prefix) return;
    const escaped = prefix.replace(/[\\%_]/g, (m) => '\\' + m);
    const exact = this.db.prepare('DELETE FROM docs WHERE library_id = ? AND rel_path = ?');
    const below = this.db.prepare("DELETE FROM docs WHERE library_id = ? AND rel_path LIKE ? ESCAPE '\\'");
    const exactFts = this.db.prepare('DELETE FROM docs_fts WHERE library_id = ? AND rel_path = ?');
    const belowFts = this.db.prepare("DELETE FROM docs_fts WHERE library_id = ? AND rel_path LIKE ? ESCAPE '\\'");
    for (const pattern of [prefix, escaped + '/%']) {
      exact.run(libraryId, pattern);
      below.run(libraryId, pattern);
      exactFts.run(libraryId, pattern);
      belowFts.run(libraryId, pattern);
    }
  }

  getDocBody(libraryId, relPath) {
    return this.db.prepare('SELECT * FROM docs WHERE library_id = ? AND rel_path = ?').get(libraryId, relPath) ?? null;
  }

  /**
   * 混合检索的"关键词"半边。中文按 3 字滑动窗口 OR 进 MATCH，否则整句当一个
   * phrase 几乎命中不了（旧插件踩过的坑）。
   */
  search({ libraryId = '', query, limit = 20 }) {
    limit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)));
    const q = buildMatchQuery(query);
    if (!q) return this.likeSearch({ libraryId, query, limit });
    const where = libraryId ? 'AND docs_fts.library_id = ?' : '';
    const args = libraryId ? [q, libraryId, limit] : [q, limit];
    try {
      const rows = this.db.prepare(
        `SELECT library_id, rel_path, title,
                snippet(docs_fts, 3, '', '', '…', 12) AS excerpt,
                bm25(docs_fts) AS score
         FROM docs_fts WHERE docs_fts MATCH ? ${where}
         ORDER BY score ASC LIMIT ?`,
      ).all(...args);
      // trigram 索引天生搜不到 1–2 个字，命中为空时退回子串扫描。
      return rows.length > 0 ? rows : this.likeSearch({ libraryId, query, limit });
    } catch {
      return this.likeSearch({ libraryId, query, limit });
    }
  }

  /** 短词/精确子串兜底：LIKE 扫描正文，摘录围绕命中位置截取。 */
  likeSearch({ libraryId = '', query, limit = 20 }) {
    limit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)));
    const needle = String(query || '').trim();
    if (!needle) return [];
    // 用户输入里的 % 和 _ 是字面量，不转义就会变成通配符。
    const pattern = '%' + needle.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    const where = libraryId ? 'AND library_id = ?' : '';
    const args = libraryId ? [pattern, libraryId, limit] : [pattern, limit];
    try {
      const rows = this.db.prepare(
        `SELECT library_id, rel_path, title, body FROM docs WHERE body LIKE ? ESCAPE '\\' ${where} LIMIT ?`,
      ).all(...args);
      return rows.map(({ body, ...row }) => {
        const at = body.toLowerCase().indexOf(needle.toLowerCase());
        if (at < 0) return { ...row, excerpt: body.slice(0, 120).replace(/\s+/g, ' ') + '…', score: 0 };
        const start = Math.max(0, at - 40);
        const excerpt = (start > 0 ? '…' : '') + body.slice(start, at + needle.length + 80).replace(/\s+/g, ' ') + '…';
        return { ...row, excerpt, score: 0 };
      });
    } catch {
      return [];
    }
  }

  countDocs(libraryId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE library_id = ?').get(libraryId).n;
  }

  allDocs(libraryId) {
    return this.db.prepare('SELECT rel_path, title, mtime_ms FROM docs WHERE library_id = ? ORDER BY rel_path').all(libraryId);
  }
}

export function buildMatchQuery(query) {
  const text = String(query || '').trim();
  if (!text) return '';
  const windows = [];
  if (/[\u3400-\u9fff]/.test(text)) {
    const compact = text.replace(/\s+/g, '');
    for (let i = 0; i + 3 <= compact.length; i++) windows.push(compact.slice(i, i + 3));
    if (windows.length === 0) return '';
    return [...new Set(windows)].map((w) => '"' + w.replaceAll('"', '""') + '"').join(' OR ');
  }
  const terms = text.split(/\s+/).filter((t) => t.length >= 2).slice(0, 12);
  if (terms.length === 0) return '';
  return terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR ');
}
