// dsh-rag — HTTP 路由（同源 fetch，仅 loopback）
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path';
import {
  SIDECAR_SUFFIX, buildTree, createDoc, createManagedLibrary, exportZip, importFiles,
  indexLibrary, isDocFile, isImageFile, moveEntry, newId, readDoc, readNotes, renameLibraryDir,
  safeEntryJoin, safeJoin, slugName, titleOf, trashEntry, trashLibraryDir, writeAtomic, writeDoc,
  writeNotes,
} from './library.js';
import { randomKey, uploadBuffer } from './qiniu.js';

const MAX_BODY = 128 * 1024 * 1024;
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
};

/** `~/notes` 这种写法用户会输入，Node 不认，这里统一展开。 */
function expandHome(input) {
  const value = String(input || '').trim();
  return value.replace(/^~(?=$|[\\/])/, homedir());
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

export function registerRoutes(ctx, rt) {
  const { store, roles, dataDir, rootDir, trashDir, config: pluginConfig } = rt;

  const configFile = join(dataDir, 'config.json');
  const readConfig = () => {
    try {
      return JSON.parse(readFileSync(configFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const writeConfig = (patch) => {
    const next = { ...readConfig(), ...patch };
    mkdirSync(dataDir, { recursive: true });
    writeAtomic(configFile, JSON.stringify(next, null, 2) + '\n', 0o600);
    return next;
  };

  const requireLib = (id) => {
    const lib = store.getLibrary(id);
    if (!lib) throw Object.assign(new Error('知识库不存在：' + id), { status: 404 });
    if (!existsSync(lib.path)) {
      throw Object.assign(new Error(`知识库目录不见了：${lib.path}`), { status: 409 });
    }
    return lib;
  };

  const libraryPayload = (lib) => ({
    id: lib.id,
    name: lib.name,
    kind: lib.kind,
    path: lib.path,
    sort: lib.sort,
    createdAt: lib.created_at,
    docCount: store.countDocs(lib.id),
  });

  const buildRolePrompt = ({ role, lib, relPath }) => {
    const lines = [];
    lines.push('【知识库上下文】');
    lines.push(`库：${lib.name}（${lib.path}）`);
    if (relPath) {
      const doc = readDoc(lib.path, relPath);
      lines.push(`文档：${relPath}`);
      if (doc.notes.length > 0) {
        lines.push('用户笔记：');
        for (const note of doc.notes.slice(0, 40)) {
          lines.push(`- ${String(note.text || '').replace(/\s+/g, ' ').slice(0, 400)}`);
        }
      }
      lines.push('');
      lines.push('正文：');
      lines.push('```markdown');
      lines.push(doc.markdown.slice(0, 60_000));
      lines.push('```');
    }
    lines.push('');
    lines.push('请按你的角色要求处理这份材料。如果材料不足以回答，直接说缺什么。');
    return lines.join('\n');
  };


  const routes = [
    ['GET', '/rag/health', async () => ({
      ok: true,
      dataDir,
      rootDir,
      chatDir: join(dataDir, 'chat'),
      libraries: store.listLibraries().length,
    })],

    ['GET', '/rag/libraries', async () => ({ libraries: store.listLibraries().map(libraryPayload) })],

    ['POST', '/rag/libraries', async (req) => {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      if (!name) throw Object.assign(new Error('缺少知识库名称'), { status: 400 });
      if (body.kind === 'mounted') {
        const path = resolvePath(expandHome(body.path));
        if (!path || !existsSync(path)) throw Object.assign(new Error('挂载目录不存在：' + path), { status: 400 });
        if (!statSync(path).isDirectory()) throw Object.assign(new Error('挂载目标不是目录：' + path), { status: 400 });
        const existing = store.listLibraries().find((l) => l.path === path);
        if (existing) throw Object.assign(new Error('这个目录已经是知识库了：' + existing.name), { status: 409 });
        const lib = store.insertLibrary({ id: newId(), name, kind: 'mounted', path });
        indexLibrary(store, lib, { force: true });
        return { library: libraryPayload(lib) };
      }
      const created = createManagedLibrary(pluginConfig.libraryRoot || rootDir, name);
      const lib = store.insertLibrary({ id: newId(), name: created.name, kind: 'managed', path: created.path });
      return { library: libraryPayload(lib) };
    }],

    ['PATCH', '/rag/libraries/:id', async (req, params) => {
      const lib = requireLib(params.id);
      const body = await readJson(req);
      let next = { name: lib.name, path: lib.path };
      if (body.name && body.name !== lib.name) {
        const renamed = renameLibraryDir(lib, body.name, pluginConfig.libraryRoot || rootDir);
        next = { name: body.name, path: renamed.path };
      }
      const updated = store.updateLibrary(lib.id, next);
      return { library: libraryPayload(updated) };
    }],

    ['POST', '/rag/libraries/reorder', async (req) => {
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      store.reorderLibraries(ids);
      return { ok: true };
    }],

    ['DELETE', '/rag/libraries/:id', async (req, params, url) => {
      const lib = requireLib(params.id);
      const withFiles = url.searchParams.get('files') === '1';
      let trashed = null;
      if (lib.kind === 'managed' && withFiles) trashed = trashLibraryDir(lib, trashDir);
      if (lib.kind === 'mounted' && withFiles) {
        throw Object.assign(new Error('挂载的库不会删除任何文件，只能取消挂载'), { status: 400 });
      }
      store.deleteLibrary(lib.id);
      return { ok: true, trashed };
    }],

    ['GET', '/rag/tree', async (_req, _params, url) => {
      const lib = requireLib(url.searchParams.get('library') || '');
      const stats = indexLibrary(store, lib);
      return {
        library: libraryPayload(lib),
        tree: buildTree(lib.path),
        stats,
      };
    }],

    ['GET', '/rag/doc', async (_req, _params, url) => {
      const lib = requireLib(url.searchParams.get('library') || '');
      const relPath = url.searchParams.get('path') || '';
      if (!relPath) throw Object.assign(new Error('缺少 path'), { status: 400 });
      const doc = readDoc(lib.path, relPath);
      return { library: libraryPayload(lib), doc };
    }],

    ['PUT', '/rag/doc', async (req) => {
      const body = await readJson(req);
      const lib = requireLib(body.library || '');
      const relPath = String(body.path || '');
      if (!relPath) throw Object.assign(new Error('缺少 path'), { status: 400 });
      // 只允许写文档本体：侧车（笔记）走 /rag/notes，别让 PUT 顺手把 .dsh.json 写成 markdown。
      if (relPath.endsWith(SIDECAR_SUFFIX) || !isDocFile(relPath)) {
        throw Object.assign(new Error('只能保存 md/markdown/txt 文档：' + relPath), { status: 400 });
      }
      const markdown = String(body.markdown ?? '');
      const saved = writeDoc(lib.path, relPath, markdown, { baseMtimeMs: Number(body.baseMtimeMs) || 0 });
      store.upsertDoc(lib.id, relPath, {
        size: saved.size,
        mtimeMs: saved.mtimeMs,
        title: titleOf(relPath, markdown),
        body: markdown,
      });
      return { ok: true, saved };
    }],

    ['POST', '/rag/doc/create', async (req) => {
      const body = await readJson(req);
      const lib = requireLib(body.library || '');
      const dir = String(body.dir || '');
      const name = String(body.name || '未命名');
      const bodyText = String(body.markdown || '');
      const relPath = createDoc(lib.path, dir, name, bodyText);
      const doc = readDoc(lib.path, relPath);
      store.upsertDoc(lib.id, relPath, {
        size: doc.size, mtimeMs: doc.mtimeMs, title: titleOf(relPath, doc.markdown), body: doc.markdown,
      });
      return { relPath };
    }],

    ['POST', '/rag/doc/mkdir', async (req) => {
      const body = await readJson(req);
      const lib = requireLib(body.library || '');
      const dir = String(body.dir || '').trim();
      const rel = safeJoin(lib.path, dir || '未命名文件夹');
      mkdirSync(rel, { recursive: true });
      return { relPath: dir || '未命名文件夹' };
    }],

    ['POST', '/rag/doc/move', async (req) => {      const body = await readJson(req);
      const lib = requireLib(body.library || '');
      const from = String(body.from || '');
      const to = String(body.to || '');
      if (!from || !to) throw Object.assign(new Error('缺少 from/to'), { status: 400 });
      const moved = moveEntry(lib.path, from, to);
      store.removeDocPrefix(lib.id, from);
      indexLibrary(store, lib);
      return { relPath: moved };
    }],

    ['DELETE', '/rag/doc', async (_req, _params, url) => {
      const lib = requireLib(url.searchParams.get('library') || '');
      const relPath = url.searchParams.get('path') || '';
      if (!relPath) throw Object.assign(new Error('缺少 path'), { status: 400 });
      const trashed = trashEntry(lib.path, relPath, trashDir);
      store.removeDocPrefix(lib.id, relPath);
      indexLibrary(store, lib);
      return { ok: true, trashed };
    }],

    ['GET', '/rag/notes', async (_req, _params, url) => {
      const lib = requireLib(url.searchParams.get('library') || '');
      const relPath = url.searchParams.get('path') || '';
      return { notes: readNotes(lib.path, relPath) };
    }],

    ['PUT', '/rag/notes', async (req) => {
      const body = await readJson(req);
      const lib = requireLib(body.library || '');
      const relPath = String(body.path || '');
      const notes = writeNotes(lib.path, relPath, body.notes || []);
      return { ok: true, notes };
    }],

    ['GET', '/rag/search', async (_req, _params, url) => {
      const query = url.searchParams.get('q') || '';
      const libraryId = url.searchParams.get('library') || '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50);
      const libraryNames = new Map(store.listLibraries().map((l) => [l.id, l.name]));
      const hits = store.search({ libraryId, query, limit }).map((hit) => ({
        libraryId: hit.library_id,
        libraryName: libraryNames.get(hit.library_id) ?? '',
        relPath: hit.rel_path,
        title: hit.title,
        excerpt: hit.excerpt,
        score: hit.score,
      }));
      return { hits };
    }],

    ['POST', '/rag/import', async (req) => {
      const body = await readJson(req);
      const lib = requireLib(body.library || '');
      const dir = String(body.dir || '');
      const files = Array.isArray(body.files) ? body.files : [];
      const result = importFiles(lib.path, dir, files, { overwrite: Boolean(body.overwrite) });
      const stats = indexLibrary(store, lib);
      return { written: result.written, skipped: result.skipped, stats };
    }],

    ['GET', '/rag/docs', async (_req, _params, url) => {
      const libraryId = url.searchParams.get('library') || '';
      const limit = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get('limit')) || 300)));
      const libraries = store.listLibraries();
      const docs = [];
      for (const lib of libraries) {
        if (libraryId && lib.id !== libraryId) continue;
        for (const doc of store.allDocs(lib.id)) {
          docs.push({
            libraryId: lib.id,
            libraryName: lib.name,
            relPath: doc.rel_path,
            title: doc.title || doc.rel_path.replace(/\.(md|markdown|txt)$/i, ''),
          });
          if (docs.length >= limit) break;
        }
        if (docs.length >= limit) break;
      }
      return { docs };
    }],

    ['POST', '/rag/upload', async (req) => {
      const body = await readJson(req);
      const lib = requireLib(body.library || '');
      const name = String(body.name || 'image.png');
      const ext = (extname(name) || '.png').toLowerCase();
      const buffer = Buffer.from(String(body.contentBase64 || ''), 'base64');
      if (buffer.length === 0) throw Object.assign(new Error('附件内容为空'), { status: 400 });
      if (buffer.length > 25 * 1024 * 1024) throw Object.assign(new Error('附件超过 25MB'), { status: 413 });

      const cfg = readConfig().qiniu || {};
      if (cfg.enabled) {
        const key = randomKey(cfg.prefix || 'dsh-rag/', ext);
        const { url } = await uploadBuffer(cfg, { key, buffer, mime: MIME[ext] || 'application/octet-stream' });
        return { url, mode: 'qiniu', key };
      }

      // 降级：本地 _assets/，按内容 hash 命名，天然去重且不会被索引当文档。
      const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 24);
      const relPath = `_assets/${hash}${ext}`;
      const abs = safeJoin(lib.path, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeAtomic(abs, buffer);
      return {
        url: `/rag/asset?library=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(relPath)}`,
        mode: 'local',
        relPath,
      };
    }],

    ['GET', '/rag/export', async (_req, _params, url) => {
      const lib = requireLib(url.searchParams.get('library') || '');
      const paths = (url.searchParams.get('paths') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const buffer = exportZip(lib.path, paths);
      const asciiName = (lib.name.replace(/[^\x20-\x7e]/g, '_') || 'knowledge-base') + '.zip';
      return { __raw: buffer, headers: {
        'content-type': 'application/zip',
        // filename* 走 RFC 5987，中文库名在浏览器里才不会变成 %E5%...
        'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(lib.name)}.zip`,
      } };
    }],

    ['GET', '/rag/asset', async (_req, _params, url) => {
      const lib = requireLib(url.searchParams.get('library') || '');
      const relPath = url.searchParams.get('path') || '';
      const abs = safeJoin(lib.path, relPath);
      if (!existsSync(abs) || !isImageFile(abs)) throw Object.assign(new Error('附件不存在'), { status: 404 });
      return {
        __raw: readFileSync(abs),
        headers: {
          'content-type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'private, max-age=300',
        },
      };
    }],

    ['GET', '/rag/roles', async () => ({
      roles: roles.list().map((role) => ({ ...role, presetId: `rag-${role.id}` })),
    })],

    ['POST', '/rag/roles', async (req) => {
      const body = await readJson(req);
      const role = roles.upsert(body);
      // 新角色要立刻能在「开角色会话」里被选到，所以同步刷新 preset。
      await rt.syncRoles?.();
      return { role };
    }],

    ['DELETE', '/rag/roles/:id', async (_req, params) => {
      const ok = roles.remove(params.id);
      if (ok) await rt.syncRoles?.();
      return { ok };
    }],

    ['GET', '/rag/config', async () => {
      const cfg = readConfig();
      const qiniu = cfg.qiniu || {};
      return {
        qiniu: {
          enabled: Boolean(qiniu.enabled),
          mode: qiniu.mode || 'local',
          bucket: qiniu.bucket || '',
          domain: qiniu.domain || '',
          region: qiniu.region || '',
          accessKey: qiniu.accessKey ? qiniu.accessKey.slice(0, 6) + '***' : '',
          hasSecret: Boolean(qiniu.secretKey),
        },
      };
    }],

    ['PUT', '/rag/config', async (req) => {
      const body = await readJson(req);
      const patch = {};
      if (body.qiniu && typeof body.qiniu === 'object') {
        const current = readConfig().qiniu || {};
        const next = { ...current };
        for (const key of ['enabled', 'mode', 'bucket', 'domain', 'region', 'accessKey', 'secretKey']) {
          if (key in body.qiniu && body.qiniu[key] !== undefined && body.qiniu[key] !== '') next[key] = body.qiniu[key];
        }
        patch.qiniu = next;
      }
      writeConfig(patch);
      return { ok: true };
    }],

    ['POST', '/rag/reindex', async (req) => {
      const body = await readJson(req);
      const lib = requireLib(body.library || '');
      return { stats: indexLibrary(store, lib, { force: Boolean(body.force) }) };
    }],

    ['POST', '/rag/role-context', async (req) => {
      const body = await readJson(req);
      const role = roles.get(body.roleId || '');
      if (!role) throw Object.assign(new Error('角色不存在：' + body.roleId), { status: 404 });
      const lib = requireLib(body.library || '');
      const prompt = buildRolePrompt({ role, lib, relPath: body.path || '' });
      return {
        role: { ...role, presetId: `rag-${role.id}` },
        presetId: `rag-${role.id}`,
        prompt,
      };
    }],
  ];

  // 路径参数路由（:id）单独处理，避免手写正则表。
  const exact = new Map();
  const parametric = [];
  for (const [method, pattern, handler] of routes) {
    if (pattern.includes('/:')) {
      const parts = pattern.split('/');
      parametric.push({ method, parts, handler });
    } else {
      exact.set(method + ' ' + pattern, handler);
    }
  }

  const matchParametric = (method, pathname) => {
    const segments = pathname.split('/');
    for (const route of parametric) {
      if (route.method !== method || route.parts.length !== segments.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const part = route.parts[i];
        if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segments[i]);
        else if (part !== segments[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  };

  ctx.inject(['webServer'], (scoped) => scoped.effect(() => scoped.webServer.register({
    kind: 'prefix',
    path: '/rag',
    async handler(req, res) {
      if (!isLoopbackRequest(req)) {
        json(res, 403, { error: '只允许本机访问' });
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      try {
        let handle = exact.get(method + ' ' + url.pathname);
        let params = {};
        if (!handle) {
          const found = matchParametric(method, url.pathname);
          if (found) { handle = found.handler; params = found.params; }
        }
        if (!handle) {
          json(res, 404, { error: '未知的接口：' + method + ' ' + url.pathname });
          return;
        }
        const result = await handle(req, params, url);
        if (result && result.__raw) {
          res.writeHead(200, result.headers || { 'content-type': 'application/octet-stream' });
          res.end(result.__raw);
          return;
        }
        json(res, 200, result);
      } catch (error) {
        const status = error?.status || ({
          ECONFLICT: 409, ENOENT: 404, EPATH: 400, EBUILTIN: 400, EEXIST: 409, ENOTDIR: 400,
        })[error?.code] || 500;
        json(res, status, { error: error?.message ?? String(error), code: error?.code });
      }
    },
  })));
}
