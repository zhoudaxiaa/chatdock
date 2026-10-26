import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function walk(dir) {
  for (const item of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await walk(file);
    else if (/\.(js|cjs|mjs)$/.test(file)) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  }
}
for (const dir of ['desktop', 'shared', 'extension', 'scripts', 'tests']) await walk(dir);
const manifest = JSON.parse(await readFile(path.join(root, 'dist/extension/manifest.json')));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
if (manifest.version !== pkg.version) throw new Error('Extension version mismatch');
execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['extension/tools/validate.py'], { cwd: root, stdio: 'inherit' });
console.log('JavaScript syntax, extension references and version checks passed.');
