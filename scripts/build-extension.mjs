import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
const out = path.join(root, 'dist/extension');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const files = ['background.js', 'session-bridge.js', 'content.js', 'provider-inject.js', 'sidepanel.html', 'sidepanel.js', 'options.html', 'options.js', 'options.css', 'prompt-input.html', 'prompt-input.js', 'rules.json', 'icons', 'shared'];
for (const file of files) await cp(path.join(root, 'extension', file), path.join(out, file), { recursive: true });
await cp(path.join(root, 'shared/providers.js'), path.join(out, 'shared/providers.js'));
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json')));
manifest.version = pkg.version;
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const zip = path.join(root, 'dist', `chatdock-extension-v${pkg.version}.zip`);
await rm(zip, { force: true });
// Python's standard library is available on every supported CI runner.
execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `import pathlib,zipfile,sys
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for p in sorted(root.rglob('*')):
  if p.is_file():
   info=zipfile.ZipInfo(p.relative_to(root).as_posix(),date_time=(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16;z.writestr(info,p.read_bytes())`, out, zip]);
console.log(`Extension: ${out}\nArchive: ${zip}`);
