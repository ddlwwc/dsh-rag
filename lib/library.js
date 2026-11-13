// dsh-rag — 文件系统层
//
// 知识库 = 磁盘目录（ADR-0004）。文档正文 = .md（ADR-0001）。
// 笔记 = 每篇文档旁边的 <文件>.dsh.json 侧车（ADR-0002）。
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import AdmZip from 'adm-zip';

export const DOC_EXT = new Set(['.md', '.markdown', '.txt']);
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
export const SIDECAR_SUFFIX = '.dsh.json';
const IGNORED_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash']);

export function newId() {
  return randomUUID();
}

export function isDocFile(name) {
  return DOC_EXT.has(extname(name).toLowerCase());
}

export function isImageFile(name) {
  return IMAGE_EXT.has(extname(name).toLowerCase());
}

export function sidecarPath(relPath) {
  return relPath + SIDECAR_SUFFIX;
}

function epath(relPath) {
  const err = new Error('路径越界：' + relPath);
  err.code = 'EPATH';
  return err;
}

/**
 * 把 relPath 解析到 root 内，拒绝绝对路径、`..` 逃逸、以及指向库外的符号链接。
 * 库内常见的符号链接（iCloud / Obsidian / 同步工具）会让纯字符串前缀校验直接失效。
 */
export function safeJoin(root, relPath = '') {
  const base = resolve(root);
  const baseReal = existsSync(base) ? realpathSync(base) : base;
  const normalized = String(relPath).replaceAll('\\', '/').replace(/^\/+/, '');
  const target = resolve(base, normalized);
  if (target !== base && !target.startsWith(base + sep)) throw epath(relPath);

  // 找到最深的一个已存在的祖先，用它的 realpath 判断真实落点。
  let probe = target;
  let dangling = false;
  while (!existsSync(probe)) {
    dangling = true;
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (existsSync(probe)) {
    const real = realpathSync(probe);
    if (real !== baseReal && !real.startsWith(baseReal + sep)) throw epath(relPath);
  }
  // 目标本身是符号链接的一律拒绝（保守）：否则读写都会跟到库外。
  if (!dangling && lstatSync(target).isSymbolicLink()) throw epath(relPath);
  return target;
}

/** 只允许操作库内的「条目」，不允许 `path=.` 把整个库搬走。 */
export function safeEntryJoin(rootDir, relPath) {
  const abs = safeJoin(rootDir, relPath);
  if (abs === resolve(rootDir)) throw epath(relPath || '.');
  return abs;
}

/** 先写 tmp + fsync 再 rename：中途崩溃不会把唯一真相源截断成半截文件。 */
export function writeAtomic(abs, data, mode) {
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w', mode ?? 0o666);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, abs);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

export function toRel(root, absPath) {
  return relative(root, absPath).split(sep).join('/');
}

export function slugName(name) {
  const cleaned = String(name || '').trim().replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').slice(0, 80);
  return cleaned || '未命名';
}

export function uniquePath(parentDir, name) {
  let candidate = join(parentDir, name);
  if (!existsSync(candidate)) return candidate;
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let i = 2; i < 500; i++) {
    candidate = join(parentDir, `${stem} ${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(parentDir, `${stem}-${Date.now()}${ext}`);
}

export function titleOf(relPath, body = '') {
  const heading = body.match(/^\s*#\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 120);
  return basename(relPath, extname(relPath));
}

// ---- 库 -------------------------------------------------------------------

export function createManagedLibrary(rootDir, name) {
  mkdirSync(rootDir, { recursive: true });
  const dir = uniquePath(rootDir, slugName(name));
  mkdirSync(dir, { recursive: true });
  return { name: slugName(name) === basename(dir) ? name : basename(dir), path: dir };
}

export function renameLibraryDir(lib, nextName, rootDir) {
  if (lib.kind !== 'managed') return { name: nextName, path: lib.path };
  if (dirname(lib.path) !== resolve(rootDir)) {
    // 已脱离默认根的托管库：只改名，不搬目录。
    return { name: nextName, path: lib.path };
  }
  const target = uniquePath(rootDir, slugName(nextName));
  renameSync(lib.path, target);
  return { name: nextName, path: target };
}

export function trashLibraryDir(lib, trashDir) {
  if (lib.kind !== 'managed') return null;
  mkdirSync(trashDir, { recursive: true });
  const target = join(trashDir, `${basename(lib.path)}-${Date.now()}`);
  renameSync(lib.path, target);
  return target;
}

// ---- 目录树 ---------------------------------------------------------------

export function buildTree(rootDir, { maxDepth = 8 } = {}) {
  const root = resolve(rootDir);
  const walk = (dir, depth) => {
    if (depth > maxDepth) return [];
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name.endsWith(SIDECAR_SUFFIX)) continue;
      const abs = join(dir, entry.name);
      const relPath = toRel(root, abs);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        nodes.push({ type: 'dir', name: entry.name, relPath, children: walk(abs, depth + 1) });
      } else if (entry.isFile()) {
        const stat = safeStat(abs);
        if (isDocFile(entry.name)) {
          nodes.push({ type: 'doc', name: entry.name, relPath, size: stat.size, mtimeMs: stat.mtimeMs });
        } else if (isImageFile(entry.name)) {
          nodes.push({ type: 'asset', name: entry.name, relPath, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    }
    nodes.sort((a, b) => {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });
    return nodes;
  };
  return walk(root, 0);
}

function safeStat(abs) {
  try {
    return statSync(abs);
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

// ---- 文档读写 -------------------------------------------------------------

export function readDoc(rootDir, relPath) {
  const abs = safeJoin(rootDir, relPath);
  if (!existsSync(abs)) {
    const err = new Error('文档不存在：' + relPath);
    err.code = 'ENOENT';
    throw err;
  }
  const stat = safeStat(abs);
  const markdown = readFileSync(abs, 'utf8');
  return {
    relPath,
    markdown,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    notes: readNotes(rootDir, relPath),
  };
}

/** 写正文。baseMtime 用于发现"外部已改过"，冲突时抛 409 语义的错误。 */
export function writeDoc(rootDir, relPath, markdown, { baseMtimeMs = 0 } = {}) {
  const abs = safeJoin(rootDir, relPath);
  const stat = safeStat(abs);
  if (baseMtimeMs && stat.mtimeMs && Math.abs(stat.mtimeMs - baseMtimeMs) > 1) {
    const err = new Error('文件已被外部修改，请重新载入后再保存');
    err.code = 'ECONFLICT';
    err.mtimeMs = stat.mtimeMs;
    throw err;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeAtomic(abs, markdown, 0o644);
  const next = safeStat(abs);
  return { relPath, mtimeMs: next.mtimeMs, size: next.size };
}

export function readNotes(rootDir, relPath) {
  const abs = safeJoin(rootDir, sidecarPath(relPath));
  if (!existsSync(abs)) return [];
  try {
    const data = JSON.parse(readFileSync(abs, 'utf8'));
    return Array.isArray(data?.notes) ? data.notes : [];
  } catch {
    // 坏文件改名留证：下一次写笔记会用新数组整份覆盖，不能连证据一起吞掉。
    try { renameSync(abs, `${abs}.corrupt-${Date.now()}`); } catch {}
    return [];
  }
}

export function writeNotes(rootDir, relPath, notes) {
  const abs = safeJoin(rootDir, sidecarPath(relPath));
  if (!Array.isArray(notes) || notes.length === 0) {
    if (existsSync(abs)) rmSync(abs, { force: true });
    return [];
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeAtomic(abs, JSON.stringify({ v: 1, notes }, null, 2) + '\n', 0o644);
  return notes;
}

// ---- 移动 / 删除 ----------------------------------------------------------

/** 移动文件或目录；托管在同一个库内时只是一次 rename，笔记侧车跟着走。 */
export function moveEntry(rootDir, fromRel, toRel) {
  const from = safeEntryJoin(rootDir, fromRel);
  const to = safeEntryJoin(rootDir, toRel);
  if (!existsSync(from)) throw new Error('源不存在：' + fromRel);
  if (existsSync(to)) throw new Error('目标已存在：' + toRel);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  if (existsSync(from + SIDECAR_SUFFIX)) renameSync(from + SIDECAR_SUFFIX, to + SIDECAR_SUFFIX);
  return toRel;
}

export function trashEntry(rootDir, relPath, trashDir) {
  const abs = safeEntryJoin(rootDir, relPath);
  if (!existsSync(abs)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(trashDir, `${stamp}-${basename(abs)}`);
  mkdirSync(trashDir, { recursive: true });
  renameSync(abs, target);
  // 笔记跟着正文一起进回收站，捞回来时还在。
  if (existsSync(abs + SIDECAR_SUFFIX)) {
    try { renameSync(abs + SIDECAR_SUFFIX, target + SIDECAR_SUFFIX); } catch {}
  }
  return target;
}

export function createDoc(rootDir, dirRel, name, body = '') {
  // 文件名也要消毒：safeJoin 只管 dirRel，名字里带 `../` 会写穿到库外。
  const raw = String(name || '').replace(/\.(md|markdown|txt)$/i, '');
  // 树和索引都会跳过点开头的条目，所以名字不能以 `.` 开头，否则文件写了却"消失"。
  const clean = slugName(raw).replace(/^\.+/, '').replace(/[. ]+$/, '') || '未命名';
  const fileName = `${clean}.md`;
  const target = uniquePath(safeJoin(rootDir, dirRel), fileName);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body || `# ${basename(target, extname(target))}\n\n`, 'utf8');
  return toRel(resolve(rootDir), target);
}

// ---- 导入 / 导出 ----------------------------------------------------------

/** files: [{ relPath, contentBase64 }]。已有同名文件默认跳过，overwrite 才覆盖。 */
export function importFiles(rootDir, dirRel, files, { overwrite = false } = {}) {
  const written = [];
  const skipped = [];
  for (const file of files || []) {
    const rel = join(dirRel, String(file.relPath || '')).split(sep).join('/');
    if (!isDocFile(rel) || /(^|\/)\.[^/]+$/.test(rel)) { skipped.push(rel); continue; }
    const abs = safeJoin(rootDir, rel);
    if (existsSync(abs) && !overwrite) { skipped.push(rel); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(file.contentBase64 || '', 'base64'));
    written.push(rel);
  }
  return { written, skipped };
}

export function exportZip(rootDir, relPaths) {
  const zip = new AdmZip();
  // 解压出来是一个以库名命名的文件夹，不会把文件撒在当前目录里。
  const top = basename(rootDir);
  const list = relPaths && relPaths.length > 0 ? relPaths : [''];
  for (const rel of list) {
    const abs = safeJoin(rootDir, rel);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      addDir(zip, rootDir, abs, top);
    } else {
      const name = top + '/' + relative(rootDir, abs).split(sep).join('/');
      zip.addFile(name, readFileSync(abs));
      const sidecar = abs + SIDECAR_SUFFIX;
      if (existsSync(sidecar)) zip.addFile(name + SIDECAR_SUFFIX, readFileSync(sidecar));
    }
  }
  return zip.toBuffer();
}

function addDir(zip, rootDir, dir, top) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      addDir(zip, rootDir, abs, top);
    } else {
      if (entry.name.endsWith(SIDECAR_SUFFIX)) continue;   // 侧车按文档逐个补，避免重复
      const name = top + '/' + relative(rootDir, abs).split(sep).join('/');
      zip.addFile(name, readFileSync(abs));
      const sidecar = abs + SIDECAR_SUFFIX;
      if (existsSync(sidecar)) zip.addFile(name + SIDECAR_SUFFIX, readFileSync(sidecar));
    }
  }
}

// ---- 索引 -----------------------------------------------------------------

export function indexLibrary(store, lib, { force = false } = {}) {
  const root = resolve(lib.path);
  const seen = new Set();
  let indexed = 0;
  let skipped = 0;
  let complete = true;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // 目录读不全（权限、外接盘掉线）就不能剪枝，否则整片索引会被当成"已删除"。
      complete = false;
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !isDocFile(entry.name)) continue;
      const relPath = toRel(root, abs);
      seen.add(relPath);
      const stat = safeStat(abs);
      const known = store.getDocBody(lib.id, relPath);
      if (!force && known && known.size === stat.size && known.mtime_ms === stat.mtimeMs) {
        skipped++;
        continue;
      }
      const body = readFileSync(abs, 'utf8').slice(0, 2_000_000);
      store.upsertDoc(lib.id, relPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        title: titleOf(relPath, body),
        body,
      });
      indexed++;
    }
  };
  walk(root);
  if (complete) {
    for (const doc of store.allDocs(lib.id)) {
      if (!seen.has(doc.rel_path)) store.removeDoc(lib.id, doc.rel_path);
    }
  } else {
    console.warn(`[dsh-rag] 索引未完整遍历（${lib.name}），跳过剪枝`);
  }
  return { indexed, skipped, total: seen.size, complete };
}

export function docHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}
