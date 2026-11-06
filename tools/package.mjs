// Zips what the extension runs from, for the Chrome Web Store and Edge Add-ons.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
const out = `dist/s1-lumen-${version}.zip`;

mkdirSync('dist', { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-rqX', out, 'manifest.json', 'content.js', 'css', 'icons', 'popup', '-x', '*.DS_Store']);
console.log(out);
