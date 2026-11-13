// 把 src/client 打成单文件 client bundle。
// DSH 只认 window.__ModuleLoader__.load({id, factory})，且不能 require 任何 dsh-client-* 包，
// 所以 react / react-dom 走宿主提供的模块表，其余全部内联。
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** emoji 语言词典（每个 75–260KB，24 份）在编辑器里只影响表情分类名，stub 掉换体积。 */
const emojiStub = {
  name: 'emoji-stub',
  setup(b) {
    b.onLoad({ filter: /@blocknote[\\/]core[\\/]dist[\\/][a-z]{2}(-[A-Za-z]+)?-[A-Za-z0-9_-]+\.js$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8');
      if (!source.startsWith('// src/emoji-data/frimousse/')) return undefined;
      const lang = args.path.match(/dist[\\/]([a-z]{2})(?:-([A-Za-z]+))?-/);
      const camel = lang ? lang[1] + (lang[2] ? lang[2][0].toUpperCase() + lang[2].slice(1) : '') : 'en';
      return {
        contents: `export default "";\nexport const ${camel}FrimousseData = "";\n`,
        loader: 'js',
      };
    });
  },
};

/**
 * BlockNote 的样式入口全是 `@import url("./x.css")`：esbuild 不拆 url() 形式的 @import，
 * 也不能把 CSS 内联成 JS 字符串（没有输出路径）。这里自己做递归内联，
 * 把整棵 @import 树摊平成一段 CSS 文本交给 text loader。
 */
const cssImportInline = {
  name: 'css-import-inline',
  setup(b) {
    const cache = new Map();
    const read = async (file) => {
      if (cache.has(file)) return cache.get(file);
      cache.set(file, '');
      const source = await readFile(file, 'utf8');
      const dir = dirname(file);
      const re = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*;/g;
      const pieces = [];
      let last = 0;
      let m;
      while ((m = re.exec(source))) {
        pieces.push(source.slice(last, m.index));
        last = m.index + m[0].length;
        const spec = m[2] ?? m[4];
        let target;
        try {
          target = spec.startsWith('.') || spec.startsWith('/')
            ? join(dir, spec)
            : createRequire(join(dir, 'noop.js')).resolve(spec);
        } catch {
          pieces.push(m[0]);
          continue;
        }
        pieces.push(await read(target));
      }
      pieces.push(source.slice(last));
      const css = pieces.join('\n');
      cache.set(file, css);
      return css;
    };
    b.onLoad({ filter: /\.css$/ }, async (args) => ({ contents: await read(args.path), loader: 'text' }));
  },
};

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.jsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  loader: { '.css': 'text', '.svg': 'text', '.png': 'dataurl', '.woff2': 'binary', '.woff': 'binary' },
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [emojiStub, cssImportInline],
  logLevel: 'info',
  metafile: true,
  minify: process.env.RAG_NO_MINIFY !== '1',
});

const js = result.outputFiles[0].text;
const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		${js}
		return module.exports;
	}
});
`;
mkdirSync(join(root, 'client'), { recursive: true });
writeFileSync(join(root, 'client/client.js'), wrapped);
// 想看体积构成时：RAG_METAFILE=/tmp/rag-meta.json node scripts/build-client.mjs
if (process.env.RAG_METAFILE) writeFileSync(process.env.RAG_METAFILE, JSON.stringify(result.metafile));
const kb = Math.round(wrapped.length / 1024);
console.log(`client/client.js ${kb} KiB`);

// 独立窗口版：系统浏览器里直接打开 /rag/standalone 时加载的那一份。
// 这里没有宿主模块表可借，react 全部打包进去，所以做成 iife 自执行。
const standalone = await build({
  absWorkingDir: root,
  entryPoints: ['src/standalone/main.jsx'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  loader: { '.css': 'text', '.svg': 'text', '.png': 'dataurl', '.woff2': 'binary', '.woff': 'binary' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [emojiStub, cssImportInline],
  logLevel: 'info',
  minify: process.env.RAG_NO_MINIFY !== '1',
});
writeFileSync(join(root, 'client/standalone.js'), standalone.outputFiles[0].text);
console.log(`client/standalone.js ${Math.round(standalone.outputFiles[0].text.length / 1024)} KiB`);
