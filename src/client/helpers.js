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
/** 临时诊断：把客户端发生的事情记到宿主 <dataDir>/debug.log（验收完就删）。 */
let debugLast = 0;
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



/** 划词高亮可选颜色：默认黄色，跟语雀一样可以按条换。 */
export const ANNOT_COLORS = [
  { id: 'yellow', name: '黄色', bg: 'rgba(255,214,10,.5)', line: 'rgba(255,190,0,.7)' },
  { id: 'green', name: '绿色', bg: 'rgba(82,196,26,.3)', line: 'rgba(82,196,26,.55)' },
  { id: 'blue', name: '蓝色', bg: 'rgba(93,120,255,.26)', line: 'rgba(93,120,255,.55)' },
  { id: 'pink', name: '粉色', bg: 'rgba(255,105,180,.3)', line: 'rgba(255,105,180,.55)' },
  { id: 'purple', name: '紫色', bg: 'rgba(160,110,255,.28)', line: 'rgba(160,110,255,.55)' },
  { id: 'none', name: '无底色', bg: 'transparent', line: 'rgba(120,120,120,.35)' },
];

export function annotationColor(color) {
  return ANNOT_COLORS.find((item) => item.id === color) || ANNOT_COLORS[0];
}
