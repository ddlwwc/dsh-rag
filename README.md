# dsh-rag · 知识库

DeepSeek Harness 的知识库插件：左侧菜单「知识库」一栏，用 BlockNote 写 markdown 笔记，
支持多知识库 / 文件夹拖拽移动 / 批量导入导出 / 块级笔记 / 自定义角色（导师、面试官、调研人员）。

## 设计原则

- **markdown 是唯一真相源**：每个文档就是磁盘上的一个 `.md` 文件，库就是目录。
  卸载插件、换编辑器、`git` 备份都不影响数据。
- **笔记存旁挂侧车**：`<文档>.dsh.json` 与正文同目录，sqlite 里不放笔记。
- **sqlite 只做索引**：全文检索用 FTS5 trigram，可随时删库重建。

架构细节见 [DESIGN.md](DESIGN.md)，术语见 [GLOSSARY.md](GLOSSARY.md)，
决策记录见 [docs/adr/](docs/adr/)。

## 安装

```bash
# 在 DSH 里把本地目录装成插件
# plugin_manager install_bundle target=link:/绝对/路径/dsh-rag
```

或者把包发布到 npm 后 `install_bundle target=dsh-rag`。

## 数据位置

| 内容 | 路径 |
| --- | --- |
| 托管知识库 | `<DSH_HOME>/rag/library/<库名>/` |
| 笔记侧车 | 与文档同目录的 `<文档>.dsh.json` |
| 检索索引 | `<DSH_HOME>/rag/rag.sqlite` |
| 角色定义 | `<DSH_HOME>/rag/roles.json` |
| 七牛配置 | `<DSH_HOME>/rag/config.json`（600 权限，仅宿主读取） |
| 角色会话 | `<DSH_HOME>/rag/chat/` |
| 回收站 | `<DSH_HOME>/rag/trash/` |

`<DSH_HOME>` 默认 `~/.dsh`，可用环境变量覆盖。

## 界面

三栏工作台：左「知识库 / 搜索 / 文档树」，中「BlockNote 富文本 + markdown 源码」，右「笔记与角色」。

- 左右两栏可收起（`‹` / `›`），状态记在 `localStorage`
- 知识库、文件夹、文档各有独立图标
- 文件夹与文档的 CRUD、导入导出都在**右键菜单**里（目录菜单还能「导入到此文件夹」「导出此文件夹」；树空白处右键可建文档、建文件夹、导入、导出整库）
- 顶栏「⤢ 独立窗口」用系统浏览器打开 `/rag/standalone`：一个只有知识库的独立窗口（Electron 主进程禁止插件 `window.open` 建窗，所以走系统浏览器；那里没有 DSH 运行时，角色按钮改为复制提示词）
- 窗口窄于 1080px 时栏头自动换行并给 macOS 窗口控件让位

## HTTP 接口

所有接口挂在 `/rag` 前缀下，只服务 loopback 同源请求：

```
GET    /rag/health
GET    /rag/libraries            POST /rag/libraries
PATCH  /rag/libraries/:id        DELETE /rag/libraries/:id?files=1
POST   /rag/libraries/reorder
GET    /rag/tree?library=
GET    /rag/doc?library=&path=   PUT /rag/doc
POST   /rag/doc/create           POST /rag/doc/mkdir
POST   /rag/doc/move             DELETE /rag/doc?library=&path=
GET    /rag/notes                PUT /rag/notes
GET    /rag/search?q=&library=   POST /rag/reindex
POST   /rag/import               GET /rag/export?library=
GET    /rag/asset?library=&path=
GET    /rag/roles                POST /rag/roles     DELETE /rag/roles/:id
GET    /rag/config               PUT /rag/config
GET    /rag/role-context
```

## Agent 工具

插件注册三个只读工具，任何会话说「从我的知识库找」时可直接用：

- `kb_list` —— 列出知识库与文档树
- `kb_search` —— 全文检索，返回带摘录的命中
- `kb_read` —— 读取某篇文档正文

## 开发

改完客户端要重新构建（宿主不构建插件）：

```bash
node scripts/build-client.mjs   # 产出 client/client.js 与 client/standalone.js
```

## 开发

```bash
pnpm install
node scripts/build-client.mjs   # 构建浏览器侧 bundle → client/client.js
node scripts/smoke-host.mjs     # 宿主侧冒烟（临时目录，不碰真实数据）
```

浏览器侧代码必须打成单文件 CJS 并包进 `window.__ModuleLoader__.load({ id, factory })`；
`react`、`react-dom` 等由宿主提供，不能打进 bundle。CSS 通过 esbuild 的 text loader
内联成字符串，在运行时以 `<style data-plugin="dsh-rag">` 注入（含 BlockNote 的 `@import` 递归展开）。

## 许可

MIT
