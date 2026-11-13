// 独立窗口版入口：由 Host 的 /rag/standalone 页面加载。
//
// 桌面端 Electron 把 window.open 一律 deny（只有 http/https 交给系统浏览器），
// 所以「新窗口」走的是：window.open(宿主 http 地址) → 系统浏览器打开这一页。
// 这一页默认没有任何 DSH 运行时，角色会话改成复制提示词，其余功能照常。
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { RagPage } from '../client/page.jsx';

const root = document.documentElement;
const dark = window.matchMedia?.('(prefers-color-scheme: dark)');
const syncTheme = () => { root.dataset.theme = dark?.matches ? 'dark' : 'light'; };
syncTheme();
dark?.addEventListener?.('change', syncTheme);

/** 在 DSH 之外没有会话可开：把角色提示词放到剪贴板，用户回 DSH 粘一下。 */
async function copyPrompt(data) {
  const text = String(data?.prompt ?? '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    window.alert('这是独立窗口，开不了 DSH 会话。角色提示词已复制，粘到 DSH 输入框即可。');
  } catch {
    window.alert('复制失败。角色提示词：\n\n' + text.slice(0, 800));
  }
}

createRoot(document.getElementById('root')).render(
  createElement(RagPage, { standalone: true, onStartRole: copyPrompt }),
);
