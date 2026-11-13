// 和 /rag Host API 说话的唯一通道。所有请求都走 JSON，二进制只有导入导出。
const BASE = '/rag';

async function request(path, options = {}) {
  const response = await fetch(BASE + path, {
    headers: options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const type = response.headers.get('content-type') || '';
  if (!response.ok) {
    let message = response.status + ' ' + response.statusText;
    if (type.includes('application/json')) {
      try {
        const body = await response.json();
        if (body?.error) message = body.error;
      } catch {}
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (type.includes('application/json')) return response.json();
  return response;
}

export const api = {
  health: () => request('/health'),

  listLibraries: () => request('/libraries'),
  createLibrary: (body) => request('/libraries', { method: 'POST', body: JSON.stringify(body) }),
  updateLibrary: (id, body) => request('/libraries/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(body) }),
  deleteLibrary: (id, purge) => request('/libraries/' + encodeURIComponent(id) + (purge ? '?files=1' : ''), { method: 'DELETE' }),
  reorderLibraries: (ids) => request('/libraries/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),

  tree: (id) => request('/tree?library=' + encodeURIComponent(id)),
  doc: (id, relPath) => request('/doc?library=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(relPath)),
  saveDoc: (body) => request('/doc', { method: 'PUT', body: JSON.stringify(body) }),
  createDoc: (body) => request('/doc/create', { method: 'POST', body: JSON.stringify(body) }),
  moveDoc: (body) => request('/doc/move', { method: 'POST', body: JSON.stringify(body) }),
  deleteDoc: (id, relPath) => request('/doc?library=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(relPath), { method: 'DELETE' }),
  mkdir: (body) => request('/doc/mkdir', { method: 'POST', body: JSON.stringify(body) }),

  notes: (id, relPath) => request('/notes?library=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(relPath)),
  saveNotes: (body) => request('/notes', { method: 'PUT', body: JSON.stringify(body) }),

  search: (id, q) => request('/search?library=' + encodeURIComponent(id || '') + '&q=' + encodeURIComponent(q)),
  importFiles: (body) => request('/import', { method: 'POST', body: JSON.stringify(body) }),
  reindex: (id) => request('/reindex', { method: 'POST', body: JSON.stringify({ library: id }) }),

  roles: () => request('/roles'),
  saveRole: (body) => request('/roles', { method: 'POST', body: JSON.stringify(body) }),
  deleteRole: (id) => request('/roles/' + encodeURIComponent(id), { method: 'DELETE' }),
  roleContext: (body) => request('/role-context', { method: 'POST', body: JSON.stringify(body) }),

  config: () => request('/config'),
  saveConfig: (body) => request('/config', { method: 'PUT', body: JSON.stringify(body) }),

  docs: (id, limit) => request('/docs?library=' + encodeURIComponent(id || '') + (limit ? '&limit=' + limit : '')),
  upload: (body) => request('/upload', { method: 'POST', body: JSON.stringify(body) }),

  exportUrl: (id, paths) => {
    let href = '/export?library=' + encodeURIComponent(id);
    if (paths && paths.length > 0) href += '&paths=' + encodeURIComponent(paths.join(','));
    return BASE + href;
  },
};

export function errorText(error) {
  if (!error) return '';
  const raw = String(error.message || error);
  if (error.status === 409) {
    // 服务端已经给了中文原因就用它，否则退回通用提示。
    return /^409\b/.test(raw) ? '文件在别处被改过，先刷新再保存。' : raw;
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) return '连不上本地服务，DSH 可能已经退出。';
  return raw;
}
