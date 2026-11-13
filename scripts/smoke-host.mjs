import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, buildMatchQuery } from '../lib/store.js';
import {
  buildTree, createDoc, createManagedLibrary, exportZip, importFiles, indexLibrary,
  moveEntry, newId, readDoc, readNotes, writeDoc, writeNotes, titleOf,
} from '../lib/library.js';

const dir = mkdtempSync(join(tmpdir(), 'dsh-rag-'));
const root = join(dir, 'library');
const store = new Store(join(dir, 'rag.sqlite')).open();

const created = createManagedLibrary(root, '我的笔记');
const lib = store.insertLibrary({ id: newId(), name: '我的笔记', kind: 'managed', path: created.path });
console.log('library:', lib.path);

const rel = createDoc(lib.path, '', 'Rust 所有权');
console.log('doc:', rel);
writeDoc(lib.path, rel, '# Rust 所有权\n\n所有权是 Rust 的核心机制，用来在编译期保证内存安全。\n\n## 借用规则\n\n同时只能有一个可变借用。\n');
const doc = readDoc(lib.path, rel);
console.log('mtime:', doc.mtimeMs > 0, 'len:', doc.markdown.length);

writeNotes(lib.path, rel, [{ id: 'n1', text: '这里和 C++ 的引用有什么区别？', anchor: { blockId: 'b1', from: 3, to: 10, quote: '编译期保证内存安全' }, createdAt: Date.now() }]);
console.log('notes:', readNotes(lib.path, rel).length);

const stats = indexLibrary(store, lib);
console.log('index:', JSON.stringify(stats));
console.log('matchQuery:', buildMatchQuery('所有权借用'));
console.log('search:', JSON.stringify(store.search({ query: '借用' })));

mkdirSync(join(lib.path, '子目录'), { recursive: true });
const rel2 = createDoc(lib.path, '子目录', '并发');
writeDoc(lib.path, rel2, '# 并发\n\nSend 与 Sync trait。\n');
indexLibrary(store, lib);
console.log('tree:', JSON.stringify(buildTree(lib.path), null, 0).slice(0, 300));

moveEntry(lib.path, rel2, '子目录/并发编程.md');
console.log('moved exists:', readFileSync(join(lib.path, '子目录/并发编程.md'), 'utf8').includes('Send'));

const zip = exportZip(lib.path, []);
console.log('zip bytes:', zip.length);

importFiles(lib.path, '导入', [{ relPath: 'a.md', contentBase64: Buffer.from('# A\n内容甲\n').toString('base64') }]);
indexLibrary(store, lib);
console.log('after import search:', JSON.stringify(store.search({ query: '内容甲' }).map((h) => h.rel_path)));

console.log('title:', titleOf(rel, doc.markdown));
console.log('docs:', store.countDocs(lib.id));
store.close();
console.log('OK', dir);
