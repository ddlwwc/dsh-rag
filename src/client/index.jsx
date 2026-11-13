// dsh-rag — Client half
//
// 两处挂载：main 面板（三栏工作台）+ sidebar.panellist 的一行（「知识库」）。
// 顺序有讲究：先 register main，再 register 侧栏行，否则 layout 会因为
// main panel 未注册而拒绝选中。
import { createElement } from 'react';
import { RagPage } from './page.jsx';

const PANEL_ID = 'rag';
const PANEL_LABEL = '知识库';

export const inject = ['slots'];

function RagIcon({ size = 16, active = false }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      opacity: active ? 1 : 0.8,
    },
    createElement('path', { d: 'M4 5.5A2 2 0 0 1 6 3.5h5.2a2 2 0 0 1 1.4.6l1.3 1.3H18a2 2 0 0 1 2 2v10.1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z' }),
    createElement('path', { d: 'M8 11.5h8M8 15h5' }),
  );
}

function workspacePathOf(item) {
  if (!item || typeof item !== 'object') return '';
  return item.path ?? item.directory ?? item.folder ?? item.cwd ?? item.root ?? '';
}

async function findChatWorkspace(workspaces, chatDir) {
  const listed = await workspaces.list();
  const items = listed?.items ?? listed?.workspaces ?? (Array.isArray(listed) ? listed : []);
  const hit = items.find((item) => workspacePathOf(item) === chatDir);
  if (hit) return hit.workspaceId ?? hit.id;
  try {
    const created = await workspaces.create({ path: chatDir });
    return created?.workspaceId ?? created?.id;
  } catch (error) {
    // 已经存在但形状没认出来：再找一次，仍找不到就交给默认工作区。
    const again = await workspaces.list();
    const retry = (again?.items ?? again?.workspaces ?? []).find((item) => workspacePathOf(item) === chatDir);
    if (retry) return retry.workspaceId ?? retry.id;
    console.warn('[dsh-rag] 角色会话目录不可用，改用当前工作区：', error?.message ?? error);
    return undefined;
  }
}

async function ensureChatWorkspace(ctx, { presetId, prompt }) {
  const workspaces = ctx.get('workspaces');
  const uiWorkspace = ctx.get('uiWorkspace');
  if (!uiWorkspace) throw new Error('DSH 还没有准备好工作区服务，稍后再试。');

  let chatDir = '';
  try {
    const response = await fetch('/rag/health');
    if (response.ok) chatDir = (await response.json()).chatDir || '';
  } catch {
    // 忽略：退回到当前工作区
  }

  let workspaceId;
  if (workspaces && chatDir) {
    try {
      workspaceId = await findChatWorkspace(workspaces, chatDir);
    } catch (error) {
      console.warn('[dsh-rag] 解析知识库会话目录失败：', error?.message ?? error);
    }
  }
  // 必须等它落地：失败时用户要能在面板里看到原因，而不是一条 unhandled rejection。
  await uiWorkspace.startSession(workspaceId, {
    agentPreset: presetId,
    prompt,
    whenDraftExists: 'replace',
  });
}

export function apply(ctx) {
  // 角色卡连点时不能把参数挂在函数属性上（后者会覆盖前者，A 的提示词配 B 的人格），显式传参。
  const startRole = (data) => {
    Promise.resolve()
      .then(() => ensureChatWorkspace(ctx, { presetId: data?.presetId, prompt: data?.prompt }))
      .catch((error) => {
        console.warn('[dsh-rag] 开角色会话失败：', error);
        window.alert('开角色会话失败：' + (error?.message ?? error));
      });
  };

  // 官方插件（ui-plugin-manager）的写法：侧栏行嵌在 main 的注册回调里，
  // 保证 layout 选中面板时侧栏行已经存在，不会 "main panel not registered"。
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register(
      { name: 'main', key: PANEL_ID },
      () => createElement(RagPage, { ctx, onStartRole: startRole }),
    );
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: PANEL_LABEL },
      (owner) => createElement(RagIcon, { size: owner?.size ?? 16, active: Boolean(owner?.active) }),
    ));
  });
}

export default { apply, inject };
