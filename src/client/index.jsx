// dsh-rag — Client half
//
// 两处挂载：main 面板（三栏工作台）+ sidebar.panellist 的一行（「知识库」）。
// 顺序有讲究：先 register main，再 register 侧栏行，否则 layout 会因为
// main panel 未注册而拒绝选中。
import { Component, createElement } from 'react';
import { RagPage } from './page.jsx';

/** 把客户端异常送回宿主，写进 <dataDir>/debug.log —— 桌面端不打运行时日志，这是唯一能查的通道。 */
function report(kind, error, info) {
  try {
    console.error('[dsh-rag]', message, info, stack);
  } catch {
    // 上报本身失败就算了
  }
}

/** 知识库页面的错误兜底：宁可显示一段红字，也别让用户对着空白页猜。 */
class RagBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    report('render', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return createElement('div', { style: { padding: 16, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap' } },
      createElement('strong', null, '知识库页面出错了：'),
      createElement('div', null, String(this.state.error?.message ?? this.state.error)),
      createElement('pre', { style: { opacity: 0.7, whiteSpace: 'pre-wrap', fontSize: 11 } }, String(this.state.error?.stack ?? '')));
  }
}

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
  if (typeof window !== 'undefined' && !window.__dshRagErrorHook) {
    window.__dshRagErrorHook = true;
    window.addEventListener('error', (event) => report('window-error', event.error || event.message));
    window.addEventListener('unhandledrejection', (event) => report('rejection', event.reason));
  }
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
      () => createElement(RagBoundary, null, createElement(RagPage, { ctx, onStartRole: startRole })),
    );
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 1, label: PANEL_LABEL },
      (owner) => createElement(RagIcon, { size: owner?.size ?? 16, active: Boolean(owner?.active) }),
    ));
  });

  // `/kb` —— 在输入框里一句话回到知识库面板。DSH 没有全局命令面板，
  // composer 的斜杠菜单就是命令面板，所以入口注册在 commandUi 上。
  ctx.inject(['commandUi', 'layout'], (scoped) => {
    scoped.effect(() => scoped.commandUi.register({
      name: 'kb',
      label: () => '打开知识库',
      description: () => '回到知识库工作台，继续读文档或跟角色对话',
      available: () => true,
      ui: {
        kind: 'action',
        run: () => {
          scoped.layout.selectPanel(PANEL_ID);
        },
      },
    }));
  });
}

export default { apply, inject };
