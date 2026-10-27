// 从 RELEASE_NOTES.md 里取出「某一个版本」的段落，作为 GitHub Release 正文。
//
// 背景：RELEASE_NOTES.md 是整本变更日志（v1.0.2 → 最新），但 Release 页面只该显示
// 当前这一版。以前 publish.mjs 和 workflow 都把整个文件塞进 Release 正文，
// 结果每个版本的说明里都拖着之前所有版本的内容。
//
// 用法：
//   node scripts/release-notes.mjs            # 取 package.json 里的版本，写到 stdout
//   node scripts/release-notes.mjs 1.4.0      # 指定版本
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOTES_FILE = path.join(ROOT, 'RELEASE_NOTES.md');

/** 版本号转义成正则片段（1.4.0 里的点是通配符，必须转义） */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 取出 `## v<version>` 到下一个二级标题之间的内容。
 * 找不到返回 null，调用方自行决定是报错还是回退。
 */
export function extractVersionSection(markdown, version) {
  const lines = markdown.split('\n');
  const heading = new RegExp(`^##\\s+v?${escapeRe(version)}\\s*$`);
  const start = lines.findIndex((l) => heading.test(l.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

/** 文件里第一个二级标题的版本号，用于「说明写没写」的校验 */
export function firstHeadingVersion(markdown) {
  const line = markdown.split('\n').find((l) => /^##\s/.test(l)) || '';
  return (line.match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
}

export function readReleaseNotes() {
  return readFileSync(NOTES_FILE, 'utf8');
}

// ---- CLI ----
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const arg = process.argv[2] || JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const version = arg.replace(/^v/, '');   // 允许直接传 tag（v1.4.0）
  const section = extractVersionSection(readReleaseNotes(), version);
  if (!section) {
    console.error(`RELEASE_NOTES.md 里找不到 ## v${version} 这一段`);
    process.exit(1);
  }
  process.stdout.write(section + '\n');
}
