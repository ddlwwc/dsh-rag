// 树行的右键菜单：CRUD 与导入导出都收在这里，行内不再挂按钮和复选框。
import { useEffect, useRef } from 'react';

const WIDTH = 190;
const ROW = 30;

export function ContextMenu({ menu, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    // capture 阶段拦下 mousedown：点在菜单外就关，点菜单内的按钮交给它自己处理。
    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const count = menu.items.filter((item) => item !== '-').length;
  const height = count * ROW + (menu.items.length - count) * 9 + 12;
  // 贴边时往回收，菜单不会被窗口切掉。
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - WIDTH - 8));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - height - 8));

  return (
    <div ref={ref} className="rag-menu" style={{ left, top, width: WIDTH }} role="menu">
      {menu.items.map((item, index) => (
        item === '-'
          ? <div key={'sep' + index} className="rag-menu-sep" />
          : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={'rag-menu-item' + (item.danger ? ' is-danger' : '')}
              onClick={() => { onClose(); item.run(); }}
            >
              {item.label}
            </button>
          )
      ))}
    </div>
  );
}
