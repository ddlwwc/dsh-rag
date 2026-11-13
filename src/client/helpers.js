// 与界面无关的小工具：主题探测、文件转 base64、笔记 id。
// 单独一层，方便别的组件引用而不必钻进 RagPage。

/** 宿主主题 → BlockNote 主题名。认不出就按浅色。 */
export function readThemeName() {
  const root = document.documentElement;
  const raw = (root.dataset.theme || root.dataset.colorScheme || root.className || '').toLowerCase();
  if (raw.includes('dark')) return 'dark';
  if (raw.includes('light')) return 'light';
  return 'light';
}

/** 跟着宿主切主题：属性/类名变了就回调一次，返回取消订阅。 */
export function observeTheme(onChange) {
  const root = document.documentElement;
  const emit = () => onChange(readThemeName());
  const observer = new MutationObserver(emit);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-color-scheme', 'class', 'style'] });
  emit();
  return () => observer.disconnect();
}

/** File → base64（不带 data: 前缀）。分块拼接，避免大图把调用栈撑爆。 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export function newNoteId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}


/**
 * 开一个独立窗口，把知识库整页搬进去（不加载 DSH 外壳，只跑我们的页面）。
 *
 * 为什么要自己搬：DSH 的面板选择只存在内存里，直接 `window.open(location.href)`
 * 打开的是会话首页，还得手动点回来。这里写一张空文档、把宿主的主题变量拷过去，
 * 再让 React 把 RagPage 挂进那个 document —— 请求仍是同源，`/rag/*` 照常可用。
 *
 * 返回 null 表示窗口被拦了，调用方自己退回页内全屏。
 */
export function openFullscreenWindow(title = '知识库') {
  const win = window.open('', 'dsh-rag-fullscreen', 'popup=yes,width=1440,height=960');
  if (!win) return null;
  const doc = win.document;
  doc.open();
  doc.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title></title><style id="rag-theme"></style></head><body></body></html>');
  doc.close();
  doc.title = title;
  doc.documentElement.dataset.theme = readThemeName();
  applyThemeVars(doc);
  return win;
}

/**
 * 把宿主的 CSS 变量抄进另一个 document。
 * 只抄 `--*` 自定义属性：我们的样式全靠 `--dsw-alias-*`，把整份样式表搬过去没必要。
 */
export function applyThemeVars(doc) {
  const style = doc.getElementById('rag-theme');
  if (!style) return;
  const computed = getComputedStyle(document.documentElement);
  const vars = [];
  for (const name of computed) {
    if (!name.startsWith('--')) continue;
    const value = computed.getPropertyValue(name);
    if (value) vars.push(`${name}:${value}`);
  }
  style.textContent = [
    ':root{' + vars.join(';') + '}',
    'html,body{margin:0;height:100%;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-text-primary,#1a1a1a);font-family:system-ui,-apple-system,"PingFang SC",sans-serif}',
    'body>*{height:100%}',
  ].join('\n');
}
