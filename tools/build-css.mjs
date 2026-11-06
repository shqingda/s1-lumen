// Compiles src/ into the CSS the extension loads, so the sources can use nesting and light-dark()
// while the extension still runs on Chrome 109, the last release for Windows 7 and 8.
// One minified file: every page parses all of it before its first paint.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { transform } from 'lightningcss';

const CHROME = 109;
const ORDER = ['tokens', 'remap', 'base', 'shell', 'index', 'forum', 'thread', 'reader', 'editor', 'generic'];

// Chrome files a rule under the class, id or tag at the end of its selector, and tries the rest
// on every element. `.a :is(.b, .c)` is one of those; `.a .b, .a .c` is not. Written out only
// where every branch weighs the same, because :is() takes the specificity of its heaviest.
const weigh = (selector) => selector.reduce((sum, part) => sum + ({ id: 100, class: 10, attribute: 10, 'pseudo-class': 10, type: 1 }[part.type] ?? 0), 0);
const plain = (selector) => selector.every(({ type }) => ['id', 'class', 'attribute', 'type'].includes(type));

const expand = (selector) => {
  const last = selector.at(-1);
  if (last?.type !== 'pseudo-class' || last.kind !== 'is') return [selector];
  const before = selector.at(-2);
  if (before && before.type !== 'combinator') return [selector];
  const branches = last.selectors;
  if (!branches.every(plain) || new Set(branches.map(weigh)).size !== 1) return [selector];
  return branches.map((branch) => [...selector.slice(0, -1), ...branch]);
};

const visitor = { Selector: (selector) => { const list = expand(selector); return list.length > 1 ? list : selector; } };

const build = (filename, code, to) => {
  const result = transform({ filename, code: Buffer.from(code), minify: true, visitor, targets: { chrome: CHROME << 16 } });
  writeFileSync(to, result.code);
};

mkdirSync('css', { recursive: true });
const sources = ORDER.map((name) => readFileSync(`src/css/${name}.css`, 'utf8')).join('\n');
build('src/css/lumen.css', sources, 'css/lumen.css');
build('src/popup.css', readFileSync('src/popup.css', 'utf8'), 'popup/popup.css');
