// dsh-rag — Host half
//
// 知识库工作台的宿主侧：库登记、目录/文档读写、笔记侧车、索引与检索、HTTP API，
// 以及把角色注册成 DSH 的 agent preset。正文永远是磁盘上的 .md。
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { Store } from './store.js';
import { RoleStore, registerRolePresets } from './roles.js';
import { registerRoutes } from './http.js';
import { buildTree, indexLibrary, readDoc, readNotes } from './library.js';

export const name = 'dsh-rag';
export const inject = ['tools', 'webServer'];

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用知识库'),
  dataDir: z.string().default('').description('数据目录，留空则用 <DSH_HOME>/rag'),
  libraryRoot: z.string().default('').description('新建知识库的默认根目录，留空则用 <dataDir>/library'),
});

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

const outputText = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };

function fail(prefix, error) {
  return prefix + '：' + (error?.message ?? String(error));
}

/** 三个 kb_* 工具共用的库解析：名字或 id 都认，留空返回 null。 */
function findLibrary(libs, nameOrId) {
  if (!nameOrId) return null;
  return libs.find((lib) => lib.name === nameOrId || lib.id === nameOrId) ?? null;
}

export function apply(ctx, config) {
  if (config.enabled === false) return;

  const dataDir = config.dataDir || join(dshHome(), 'rag');
  const rootDir = config.libraryRoot || join(dataDir, 'library');
  const trashDir = join(dataDir, 'trash');
  mkdirSync(rootDir, { recursive: true });

  const store = new Store(join(dataDir, 'rag.sqlite')).open();
  ctx.effect(() => () => store.close());

  const roles = new RoleStore(dataDir);
  let rolesHandle = null;
  let presetScope = null;
  // 角色增删改后要重新注册 preset：agentPresets 是快照式的，不会自己更新。
  // 串行化：连点两次"保存角色"时，两个刷新会互相踩掉 disposer，留下重复注册的 preset。
  let refreshing = Promise.resolve();
  const refreshRolePresets = () => {
    refreshing = refreshing.then(async () => {
      await rolesHandle?.dispose();
      rolesHandle = null;
      if (!presetScope) return;
      const handle = await registerRolePresets(presetScope, roles.list());
      rolesHandle = handle;
      if (handle.errors.length > 0) {
        console.warn('[dsh-rag] 角色 preset 注册部分失败：' + handle.errors.join('; '));
      }
    }).catch((error) => {
      console.warn('[dsh-rag] 角色 preset 注册失败：' + (error?.message ?? error));
    });
    return refreshing;
  };
  ctx.effect(() => () => {
    refreshing.then(() => rolesHandle?.dispose()).catch(() => {});
  });
  ctx.inject(['agentPresets'], (scoped) => {
    presetScope = scoped;
    refreshRolePresets().catch((error) => {
      console.warn('[dsh-rag] 角色 preset 注册失败：' + (error?.message ?? error));
    });
  });

  // 打开时补一次差异索引，避免"刚写的文档搜不到"。放到下一轮事件循环里，
  // 大库第一次全量扫描不该卡住宿主启动。
  setImmediate(() => {
    for (const lib of store.listLibraries()) {
      try {
        indexLibrary(store, lib, { force: false });
      } catch (error) {
        console.warn(`[dsh-rag] 索引 ${lib.name} 失败：${error?.message ?? error}`);
      }
    }
  });

  registerRoutes(ctx, {
    store, roles, dataDir, rootDir, trashDir,
    config: { ...config, libraryRoot: rootDir },
    syncRoles: () => refreshRolePresets(),
  });

  const toolDefs = [
    {
      name: 'kb_list',
      description: '列出知识库及其文档。可只给 library 查某个库的目录树，或给 library + path 看某一篇。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          library: { type: 'string', description: '知识库名称（留空列出所有库）' },
          path: { type: 'string', description: '文档相对路径（给了就读这篇）' },
        },
      },
      output: outputText,
      async execute(args) {
        try {
          const libs = store.listLibraries();
          const lib = findLibrary(libs, args.library);
          if (args.library && !lib) return fail('没有这个知识库', args.library);
          if (lib && args.path) {
            const doc = readDoc(lib.path, args.path);
            const notes = doc.notes.length > 0
              ? '\n\n笔记：\n' + doc.notes.map((n) => `- ${n.text}`).join('\n')
              : '';
            return doc.markdown + notes;
          }
          if (lib) {
            const tree = buildTree(lib.path);
            const render = (nodes, depth = 0) => nodes.flatMap((node) => {
              const pad = '  '.repeat(depth);
              if (node.type === 'dir') return [`${pad}${node.name}/`, ...render(node.children, depth + 1)];
              return [`${pad}${node.name}`];
            });
            return `# ${lib.name}（${lib.path}）\n\n` + render(tree).join('\n');
          }
          if (libs.length === 0) return '还没有知识库。在左侧「知识库」里新建一个。';
          return libs.map((l) => `- ${l.name}（${store.countDocs(l.id)} 篇）${l.path}`).join('\n');
        } catch (error) {
          return fail('失败', error);
        }
      },
    },
    {
      name: 'kb_search',
      description: '在知识库里按关键词/短语检索文档片段（中文按 3 字窗口做子串匹配），返回库名、路径与命中摘录。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索词' },
          library: { type: 'string', description: '限定知识库（留空搜全部）' },
          limit: { type: 'number', description: '返回条数，默认 10' },
        },
        required: ['query'],
      },
      output: outputText,
      async execute(args) {
        try {
          const libs = store.listLibraries();
          const lib = findLibrary(libs, args.library);
          if (args.library && !lib) return fail('没有这个知识库', args.library);
          const names = new Map(libs.map((l) => [l.id, l.name]));
          const hits = store.search({ libraryId: lib?.id ?? '', query: args.query, limit: Math.min(args.limit || 10, 30) });
          if (hits.length === 0) return `没有命中「${args.query}」。试试更短的关键词，或先打开知识库页让它建索引。`;
          return hits.map((hit, i) =>
            `${i + 1}. ${names.get(hit.library_id) ?? '?'} / ${hit.rel_path}\n   ${hit.excerpt}`,
          ).join('\n\n');
        } catch (error) {
          return fail('失败', error);
        }
      },
    },
    {
      name: 'kb_read',
      description: '读取知识库里某篇文档的正文与笔记。用于把用户笔记作为上下文。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          library: { type: 'string', description: '知识库名称或 id' },
          path: { type: 'string', description: '文档相对路径，例如 notes/rust.md' },
        },
        required: ['library', 'path'],
      },
      output: outputText,
      async execute(args) {
        try {
          const lib = findLibrary(store.listLibraries(), args.library);
          if (!lib) return fail('没有这个知识库', args.library);
          const doc = readDoc(lib.path, args.path);
          const notes = doc.notes.length > 0
            ? '\n\n---\n笔记：\n' + doc.notes.map((n) => `- ${n.text}`).join('\n')
            : '';
          return doc.markdown + notes;
        } catch (error) {
          return fail('失败', error);
        }
      },
    },
  ];

  // register() 一次只收一个定义。
  for (const definition of toolDefs) ctx.tools.register(definition);

  // 让模型知道「这台机器上有知识库」，否则它不会主动调 kb_*。
  // 每次组装都同步读一遍库列表，用户新建/改名后立刻反映到提示里。
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'dsh-rag:knowledge-base',
      order: 55,
      text: () => knowledgeSection(store),
    }));
  });
}

/** 系统提示里的知识库段落：尽量短，只给「有什么、怎么查、怎么引用」。 */
function knowledgeSection(store) {
  let libs = [];
  try {
    libs = store.listLibraries();
  } catch {
    return '';
  }
  if (libs.length === 0) return '';
  const rows = libs.slice(0, 8).map((lib) => {
    let count = 0;
    try { count = store.countDocs(lib.id); } catch { /* 索引还没建好就先不报数 */ }
    return `- ${lib.name}（${count} 篇）`;
  });
  const more = libs.length > 8 ? `\n- …另有 ${libs.length - 8} 个库，用 kb_list 看全量` : '';
  return [
    '## 用户的知识库',
    '这台机器上装了 dsh-rag 知识库，写作/答疑需要用户自己的资料时先查这里，不要凭印象编：',
    rows.join('\n') + more,
    '',
    '用法：`kb_list` 看目录树；`kb_search` 按关键词检索片段（中文两三个字也能搜）；`kb_read` 读整篇正文与用户在文档里写的笔记。',
    '引用时写清「库名 / 文档路径」，并优先采信文档正文；文档没提到的不要补。',
  ].join('\n');
}
