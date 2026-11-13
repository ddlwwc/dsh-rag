// 三种对象三种图标：库 = 书架，文件夹 = 文件夹，文档 = 一页纸。
// 一律 currentColor + 描边，跟随宿主明暗主题，不引任何图标库（包里塞不下也犯不上）。

export function LibraryIcon({ size = 14 }) {
  return (
    <svg className="rag-ico rag-ico-lib" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 13.5h12" />
      <rect x="2.6" y="4.6" width="2.9" height="8.9" rx=".7" />
      <rect x="6.6" y="2.6" width="2.9" height="10.9" rx=".7" />
      <path d="M11.6 4.4l2 .6-1.7 8.5-2-.6z" />
    </svg>
  );
}

export function FolderIcon({ size = 14 }) {
  return (
    <svg className="rag-ico rag-ico-folder" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.6c0-.6.4-1 1-1h3l1.4 1.6H13c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
    </svg>
  );
}

export function DocIcon({ size = 14 }) {
  return (
    <svg className="rag-ico rag-ico-doc" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2.4h5l3 3v8.2c0 .5-.4.9-.9.9H4.9c-.5 0-.9-.4-.9-.9z" />
      <path d="M9 2.6v3h2.8" />
      <path d="M5.8 8.4h4.4M5.8 10.8h3.2" />
    </svg>
  );
}
