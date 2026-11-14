// 全部样式内联成一段文本注入 <style data-plugin="dsh-rag">。
// 不引外部 css 文件：宿主不保证插件的静态资源能被加载。

export const RAG_CSS = `
.rag-root{--rag-rail:264px;--rag-side:300px;position:relative;display:grid;grid-template-columns:var(--rag-rail) minmax(0,1fr) var(--rag-side);height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-text-primary,#1a1a1a);font-size:13px}
.rag-root *{box-sizing:border-box}
.rag-rail,.rag-side{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));overflow:hidden}
.rag-rail{grid-column:1}
.rag-main{grid-column:2}
.rag-side{grid-column:3}
.rag-side{border-right:none;border-left:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));overflow-y:auto;padding:4px 0 24px}
.rag-rail-head{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;padding:10px 12px 6px;min-width:0}
.rag-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:14px}
.rag-rail-actions{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.rag-btn{border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));background:transparent;color:inherit;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer}
.rag-btn:hover{background:rgba(0,0,0,.04)}
.rag-btn:disabled{opacity:.4;cursor:default}
.rag-btn-primary{background:var(--dsw-alias-accent,#2f6bff);border-color:transparent;color:#fff}
.rag-btn-ghost{border-color:transparent}
.rag-link{border:none;background:none;color:var(--dsw-alias-accent,#2f6bff);cursor:pointer;font-size:12px;padding:0 2px}
.rag-libs{max-height:34%;overflow-y:auto;padding:2px 6px}
.rag-lib{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer}
.rag-ico{flex:0 0 auto;opacity:.5}
.rag-ico-lib{opacity:.8}
.rag-lib.is-active .rag-ico,.rag-row.is-active .rag-ico{opacity:1;color:var(--dsw-alias-accent,#2f6bff)}
.rag-icon-btn{border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));background:transparent;color:inherit;opacity:.75;cursor:pointer;font-size:15px;line-height:1;padding:4px 9px;border-radius:6px;min-width:28px}
.rag-icon-btn:hover{opacity:1;background:rgba(0,0,0,.06)}
.rag-lib:hover{background:rgba(0,0,0,.03)}
.rag-lib.is-active{background:rgba(47,107,255,.1)}
.rag-lib-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rag-lib-count{font-size:11px;opacity:.5}
.rag-search{padding:6px 10px}
.rag-search input{width:100%;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));background:transparent;color:inherit;border-radius:6px;padding:5px 8px;font-size:12px}
.rag-tree-actions{display:flex;flex-wrap:wrap;gap:2px;padding:0 8px 6px}
.rag-tree{flex:1;overflow-y:auto;padding:0 6px}
.rag-tree-wrap{display:flex;flex-direction:column;min-height:0;flex:1}
.rag-tree.is-drop{outline:1px dashed var(--dsw-alias-accent,#2f6bff);outline-offset:-2px;border-radius:6px}
.rag-row{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;cursor:pointer;user-select:none}
.rag-row:hover{background:rgba(0,0,0,.04)}
.rag-row.is-active{background:rgba(47,107,255,.12)}
.rag-row.is-drop{background:rgba(47,107,255,.18)}
.rag-caret{width:10px;font-size:10px;opacity:.6}
.rag-dot{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.3;margin-left:4px}
.rag-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rag-hint{margin:0 10px 6px;font-size:11px;line-height:1.5;opacity:.55}

.rag-lib.is-dragging{opacity:.45}
.rag-lib.is-drop{box-shadow:inset 0 2px 0 var(--dsw-alias-accent,#2f6bff);border-radius:6px}

.rag-menu{position:fixed;z-index:95;padding:5px;border-radius:11px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.1));background:var(--dsw-alias-bg-elevated,#fff);box-shadow:0 12px 32px rgba(0,0,0,.16);backdrop-filter:blur(8px)}
.rag-menu-item{display:block;width:100%;text-align:left;border:none;background:none;cursor:pointer;font:inherit;font-size:12.5px;color:inherit;padding:6px 10px;border-radius:7px}
.rag-menu-item:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.06))}
.rag-menu-item.is-danger{color:#c0392b}
.rag-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-subtle,rgba(0,0,0,.08))}
.rag-hits{flex:1;overflow-y:auto;padding:0 8px}
.rag-hits-head{display:flex;justify-content:space-between;font-size:11px;opacity:.6;padding:2px 4px 6px}
.rag-hits-tools{display:flex;gap:8px}
.rag-role-pick{display:flex;flex-wrap:wrap;gap:4px;padding:0 4px 8px}
.rag-role-chip{border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));background:transparent;color:inherit;border-radius:999px;padding:2px 10px;font-size:11px;cursor:pointer}
.rag-role-chip:hover{background:rgba(47,107,255,.1);border-color:rgba(47,107,255,.4)}
.rag-hit{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;border:none;background:transparent;color:inherit;padding:6px 8px;border-radius:6px;cursor:pointer}
.rag-hit:hover{background:rgba(0,0,0,.04)}
.rag-hit-title{font-weight:600}
.rag-hit-path{font-size:11px;opacity:.55}
.rag-hit-excerpt{font-size:11px;opacity:.75;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rag-main{display:flex;flex-direction:column;min-width:0;min-height:0}
.rag-main-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;row-gap:6px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08))}
.rag-crumbs{display:flex;align-items:center;gap:8px;min-width:0}
.rag-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.05)}
.rag-chip-warn{border:1px solid rgba(180,83,9,.35);background:rgba(245,158,11,.14);color:#b45309;cursor:pointer;font-size:11px;padding:2px 8px;border-radius:999px}
.rag-crumb-path{font-size:12px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rag-main-actions{display:flex;gap:6px;align-items:center}
.rag-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));border-radius:6px;overflow:hidden}
.rag-seg button{border:none;background:transparent;color:inherit;padding:3px 8px;font-size:12px;cursor:pointer}
.rag-seg button.is-on{background:rgba(47,107,255,.12)}
.rag-banner{padding:6px 16px;font-size:12px;background:rgba(47,107,255,.08)}
.rag-toast{position:fixed;right:24px;bottom:24px;z-index:75;padding:7px 14px;border-radius:999px;font-size:12px;background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-text-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));box-shadow:0 8px 24px rgba(0,0,0,.16);pointer-events:none}
.rag-banner.is-error{background:rgba(220,38,38,.1);display:flex;justify-content:space-between}
.rag-doc{flex:1;min-height:0;overflow:auto}
.rag-blank{padding:60px 40px;opacity:.7}
.rag-blank h2{font-size:16px;margin:0 0 8px}
.rag-editor-shell{padding:16px 24px 120px}
.rag-source{display:flex;flex-direction:column;height:100%;min-height:0}
.rag-source-head{display:flex;justify-content:space-between;align-items:center;padding:8px 24px;font-size:11px;opacity:.6;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06))}
.rag-source-body{margin:0;padding:16px 24px 120px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.rag-side-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 10px 2px 12px;font-size:12px;font-weight:600;opacity:.75}
.rag-side-block{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06))}
.rag-side-head{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px}
.rag-notes{display:flex;flex-direction:column;gap:8px}
.rag-note{border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.1));border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.rag-note.is-draft{background:rgba(47,107,255,.05)}
.rag-note textarea{width:100%;min-height:56px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));border-radius:6px;background:transparent;color:inherit;font-size:12px;padding:6px;resize:vertical}
.rag-note-quote{font-size:12px;opacity:.8;border-left:2px solid rgba(0,0,0,.1);padding-left:6px;margin:0;cursor:pointer}
.rag-note-offset{opacity:.55;font-size:11px;margin-left:4px}
.rag-note-drift{font-size:11px;margin:0;color:#b45309;opacity:.9}

.rag-note-text{margin:0;white-space:pre-wrap}
.rag-note-actions{display:flex;gap:8px}
.rag-roles{display:flex;flex-direction:column;gap:6px}
.rag-role{display:flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.1));border-radius:8px;padding:2px 4px 2px 0}
.rag-role:hover{background:rgba(47,107,255,.06)}
.rag-role-open{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;text-align:left;border:none;background:transparent;color:inherit;padding:6px 10px;cursor:pointer;border-radius:8px}
.rag-role-tools{display:flex;gap:4px;padding-right:6px}
.rag-role-tools button{border:none;background:none;color:inherit;opacity:.55;font-size:11px;cursor:pointer;padding:2px 4px}
.rag-role-tools button:hover{opacity:1;color:var(--dsw-alias-accent,#2f6bff)}
.rag-role-name{font-weight:600}
.rag-role-desc{font-size:11px;opacity:.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rag-hint{font-size:11px;opacity:.55;margin:6px 0 0}
.rag-empty{font-size:12px;opacity:.55;padding:6px 8px;margin:0}
.rag-side-toggle{display:none}
.rag-drawer-close{display:none}
/* 栏位开合：贴在分栏线上、垂直居中的小竖条，不占行高也不挤正文 */
.rag-edge-toggle{position:absolute;top:50%;transform:translateY(-50%);z-index:24;display:flex;align-items:center;justify-content:center;width:15px;height:46px;padding:0;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));background:var(--dsw-alias-bg-elevated,#fff);color:inherit;font-size:11px;line-height:1;border-radius:8px;cursor:pointer;opacity:.42;transition:opacity .15s ease}
.rag-edge-toggle:hover{opacity:1;background:var(--dsw-alias-bg-hover,rgba(0,0,0,.06))}
.rag-edge-toggle.is-left{left:calc(var(--rag-rail) - 8px)}
.rag-edge-toggle.is-right{right:calc(var(--rag-side) - 8px)}
.rag-root.is-rail-collapsed .rag-edge-toggle.is-left{left:2px}
.rag-root.is-side-collapsed .rag-edge-toggle.is-right{right:2px}
@media (max-width: 1080px){
  .rag-root{--rag-rail:200px;grid-template-columns:var(--rag-rail) minmax(0,1fr)}
  .rag-rail-head{padding-top:40px}
  .rag-side{position:fixed;top:0;right:0;bottom:0;width:300px;z-index:70;background:var(--dsw-alias-bg-elevated,#fff);box-shadow:-12px 0 32px rgba(0,0,0,.18);transform:translateX(100%);transition:transform .18s ease}
  .rag-side.is-open{transform:none}
  .rag-side-toggle{display:inline-flex}
  .rag-drawer-close{display:inline-flex}
  .rag-edge-toggle.is-right{right:6px}
}
@media (max-width: 760px){
  .rag-root{--rag-rail:0px;grid-template-columns:minmax(0,1fr)}
  .rag-rail{display:none}
}
.rag-root.is-rail-collapsed{--rag-rail:0px}
.rag-root.is-side-collapsed{--rag-side:0px}
.rag-root.is-rail-collapsed .rag-rail,.rag-root.is-side-collapsed .rag-side{overflow:hidden;padding:0;border:0}
.rag-root.is-rail-collapsed .rag-rail>*,.rag-root.is-side-collapsed .rag-side>*{visibility:hidden}
.rag-fullscreen{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;padding-top:44px;background:var(--dsw-alias-bg-base,#fff)}
.rag-fullscreen>.rag-root{flex:1;min-height:0}
.rag-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:80}
.rag-modal{width:min(420px,86vw);background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-text-primary,inherit);border-radius:12px;padding:16px 18px;box-shadow:0 18px 48px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:12px;font-size:13px}
.rag-modal-title{margin:0;font-weight:600;line-height:1.5}
.rag-modal-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.18));border-radius:8px;padding:8px 10px;font-size:13px;background:transparent;color:inherit;outline:none}
.rag-modal-input:focus{border-color:rgba(47,107,255,.6)}
.rag-modal-actions{display:flex;justify-content:flex-end;gap:8px}
`;
