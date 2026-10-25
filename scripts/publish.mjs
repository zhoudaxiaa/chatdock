#!/usr/bin/env node
/**
 * 一键发版：读 package.json 版本 → 打 tag → 推 main/tag → 创建 GitHub Release
 * （Release 创建后由 .github/workflows/build-release.yml 构建并回传安装包）
 *
 * 用法：
 *   node scripts/publish.mjs              # 正式发布
 *   node scripts/publish.mjs --dry-run    # 只打印将要做什么，不写远端
 *   node scripts/publish.mjs --draft      # 创建草稿 Release（不触发构建，需手动发布）
 *   node scripts/publish.mjs --no-wait    # 不等 CI 构建，创建完就退出
 *
 * 前置约定：
 *   - 版本号只改 package.json（唯一来源），tag 由脚本派生，避免两处不一致；
 *   - RELEASE_NOTES.md 的首个标题必须是 `## v<版本号>`——工作流用它的内容
 *     覆盖 Release 正文，标题对不上说明忘更新说明或忘改版本，直接拒绝发布；
 *   - 工作区必须干净、必须已推送，脚本不会 `git add -A`、也不会强推 tag。
 *
 * 凭据：优先 GITHUB_TOKEN / GH_TOKEN 环境变量，否则读 git credential helper
 * （Windows 上是 Git Credential Manager）里已存的 github.com 凭据。全程不打印 token。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根目录（本文件在 scripts/ 下）
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const DRAFT = ARGS.includes('--draft');
const WAIT = !ARGS.includes('--no-wait');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

const log = (m) => console.log(`\n==> ${m}`);
const step = (m) => console.log(`    ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg, hint) {
  console.error(`\n!! ${msg}`);
  if (hint) console.error(`   ${hint}`);
  process.exit(1);
}

/** 跑 git 命令，返回 { ok, out, err }（需要自己判断成败时用） */
function gitTry(args) {
  const ps = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: ps.status === 0, out: (ps.stdout || '').trim(), err: (ps.stderr || '').trim() };
}

/** 跑 git 命令，失败即退出（大多数检查用这个） */
function git(args, { allowFail = false } = {}) {
  const r = gitTry(args);
  if (!r.ok) {
    if (allowFail) return null;
    die(`git ${args.join(' ')} 失败`, r.err || `exit ${r.status}`);
  }
  return r.out;
}

/* ------------------------------ 版本与说明 ------------------------------ */

const pkgPath = path.join(ROOT, 'package.json');
if (!existsSync(pkgPath)) die('找不到 package.json，请在项目根目录运行');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;

if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  die(`package.json 的 version 不是 x.y.z 形式：${VERSION}`);
}

const notesPath = path.join(ROOT, 'RELEASE_NOTES.md');
if (!existsSync(notesPath)) die('找不到 RELEASE_NOTES.md（工作流用它作为 Release 正文）');
const notes = readFileSync(notesPath, 'utf8');
const heading = (notes.split('\n').find((l) => /^#{1,2}\s/.test(l)) || '').trim();
const headingVersion = (heading.match(/(\d+\.\d+\.\d+)/) || [])[1];
if (headingVersion !== VERSION) {
  die(
    `RELEASE_NOTES.md 的首个标题是「${heading || '(空)'}」，与 package.json 的 ${VERSION} 对不上`,
    '发布说明是 Release 正文的唯一来源，请先把标题与正文改成这一版的内容（旧版日志折叠进 <details>）。'
  );
}

/* ------------------------------ 仓库前置检查 ------------------------------ */

const remotes = git(['remote', '-v']);
const originLine = remotes.split('\n').find((l) => l.startsWith('origin\t') && l.includes('(push)'));
if (!originLine) die('没有名为 origin 的远端');
const originUrl = originLine.split(/\s+/)[1];

// 支持 https://github.com/owner/repo(.git) 与 git@github.com:owner/repo(.git)
const m = originUrl.match(/github\.com[:/]+([^/]+)\/([^/\s]+?)(?:\.git)?$/);
if (!m) die(`无法从 origin 解析 GitHub 仓库地址：${originUrl}`);
const [, OWNER, REPO] = m;
const SLUG = `${OWNER}/${REPO}`;

const branch = git(['branch', '--show-current']);
if (branch !== 'main') die(`当前分支是 ${branch || '(游离 HEAD)'}，发布只能在 main 上做`);

const dirty = git(['status', '--porcelain']);
if (dirty) {
  if (!DRY) {
    die('工作区有未提交的改动，先提交或 stash 再发布：', dirty.split('\n').map((l) => `   ${l}`).join('\n'));
  }
  // --dry-run 只预览、不写远端，即使工作区脏也允许跑
  step('(--dry-run) 工作区有未提交改动，仅预览，已忽略');
}

log('同步远端');
// GitHub 的 HTTPS 在部分网络下会偶发 schannel / CONNECT 502，重试几次再决定是否降级
let fetched = false;
let lastFetchError = '';
for (const wait of [0, 3000, 6000, 10000]) {
  if (wait) await sleep(wait);
  const r = gitTry(['fetch', '--tags', 'origin']);
  if (r.ok) {
    fetched = true;
    break;
  }
  lastFetchError = r.err;
}
if (!fetched) {
  step('拉取远端失败，改用本地缓存的 origin/main 判断是否同步：' + lastFetchError.split('\n')[0]);
}
const localSha = git(['rev-parse', 'main']);
const remoteSha = git(['rev-parse', 'origin/main'], { allowFail: true });
if (remoteSha === null) die('远端没有 main 分支');
if (localSha !== remoteSha) {
  const ahead = Number(git(['rev-list', '--count', 'origin/main..main']) || 0);
  const behind = Number(git(['rev-list', '--count', 'main..origin/main']) || 0);
  die(
    `本地 main 与 origin/main 不一致（领先 ${ahead} / 落后 ${behind}）`,
    behind > 0 ? '先 git pull --rebase 再发布' : '先 git push origin main 再发布'
  );
}
step(`main @ ${localSha.slice(0, 7)} 已与远端一致`);

// tag 不能已存在（本地 / 远端都不要），避免覆盖已发布的版本
const tagLocal = git(['tag', '-l', TAG]);
if (tagLocal) die(`本地已存在 tag ${TAG}`, '发新版请先把 package.json 的 version 递增');
const tagRemote = git(['ls-remote', '--tags', 'origin', `refs/tags/${TAG}`], { allowFail: true });
// ls-remote 失败（网络抖动）时返回 null：交给后面推送 tag 失败来兜底
if (tagRemote) die(`远端已存在 tag ${TAG}`, '该版本已发布过，直接改版本号');

step(`版本 ${VERSION} → tag ${TAG}`);

/* ------------------------------ GitHub API ------------------------------ */

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const ps = spawnSync('git', ['credential', 'fill'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\n\n',
    env: GIT_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const found = /^password=(.+)$/m.exec(ps.stdout || '');
  return found ? found[1].trim() : null;
}

const token = readToken();
if (!token) die('拿不到 GitHub 凭据', '设置 GITHUB_TOKEN 环境变量，或先用 git 推送一次让凭据管理器记住凭据');

const api = async (p, init = {}) => {
  const res = await fetch(`https://api.github.com${p}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `${REPO}-release-script`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  return res;
};

log('检查 Release 是否已存在');
const existing = await api(`/repos/${SLUG}/releases/tags/${TAG}`);
if (existing.ok) {
  const r = await existing.json();
  die(`${TAG} 的 Release 已存在：${r.html_url}`, '要重发请先到 GitHub 上删除该 Release 与 tag');
}
if (existing.status !== 404) {
  die(`查询 Release 失败（HTTP ${existing.status}）`, (await existing.text()).slice(0, 300));
}
step(`远端没有 ${TAG} 的 Release`);

/* ------------------------------ 打 tag / 推送 ------------------------------ */

if (DRY) {
  log('--dry-run：以下操作被跳过');
  step(`git tag -a ${TAG}`);
  step(`git push origin ${TAG}`);
  step(`POST /repos/${SLUG}/releases  (name=${TAG}, draft=${DRAFT})`);
  step('创建工作流构建：扩展包 / Windows x64 / macOS arm64');
  console.log('\nDRY-RUN OK');
  process.exit(0);
}

log(`创建并推送 tag ${TAG}`);
git(['tag', '-a', TAG, '-m', `${TAG} — ${heading.replace(/^#+\s*/, '') || 'release'}`]);
const pushed = gitTry(['push', 'origin', TAG]);
if (!pushed.ok) {
  // 推送失败就回收本地 tag，避免下次运行被「本地已存在 tag」挡住
  gitTry(['tag', '-d', TAG]);
  die(`推送 tag ${TAG} 失败，已删除本地 tag`, pushed.err);
}
step('tag 已推送');

/* ------------------------------ 创建 Release ------------------------------ */

log('创建 Release');
const created = await api(`/repos/${SLUG}/releases`, {
  method: 'POST',
  body: JSON.stringify({
    tag_name: TAG,
    name: TAG,
    body: notes,
    draft: DRAFT,
    prerelease: false,
  }),
});
const createdText = await created.text();
if (!created.ok) die(`创建 Release 失败（HTTP ${created.status}）`, createdText.slice(0, 500));
const release = JSON.parse(createdText);
step(release.html_url);

if (DRAFT) {
  console.log('\n!! 已创建为草稿 Release：草稿不会触发构建，请在网页上点击 Publish 后再等 CI 出包。');
  console.log('DONE (draft)');
  process.exit(0);
}

if (!WAIT) {
  console.log('\n已触发构建，未等待结果（--no-wait）。进度：');
  console.log(`  https://github.com/${SLUG}/actions`);
  process.exit(0);
}

/* ------------------------------ 等待 CI 构建 ------------------------------ */

log('等待 GitHub Actions 构建（扩展 / Windows x64 / macOS arm64）');

let runId = null;
for (let i = 0; i < 24 && !runId; i++) {
  const res = await api(`/repos/${SLUG}/actions/runs?event=release&per_page=10`);
  if (res.ok) {
    const j = await res.json();
    const hit = (j.workflow_runs || []).find((r) => r.head_branch === TAG);
    if (hit) runId = hit.id;
  }
  if (!runId) await sleep(5000);
}
if (!runId) die('没找到对应的构建任务', `去 https://github.com/${SLUG}/actions 看看是否被 workflow 权限拦住了`);

let lastLine = '';
for (let i = 0; i < 90; i++) {
  const run = await (await api(`/repos/${SLUG}/actions/runs/${runId}`)).json();
  const jobs = await (await api(`/repos/${SLUG}/actions/runs/${runId}/jobs`)).json();
  const line = (jobs.jobs || [])
    .map((j) => `${j.name}=${j.conclusion || j.status}`)
    .join('  ');
  if (line !== lastLine) {
    step(`[${run.status}${run.conclusion ? '/' + run.conclusion : ''}] ${line}`);
    lastLine = line;
  }
  if (run.status === 'completed') {
    if (run.conclusion !== 'success') {
      die(`构建失败：${run.html_url}`, '看日志修完再发一版，脚本不会自动重试');
    }
    const rel = await (await api(`/repos/${SLUG}/releases/tags/${TAG}`)).json();
    log('产物');
    if (!rel.assets?.length) {
      console.log('   (没有资产，可能 fail_on_unmatched_files 关闭了，检查构建日志)');
    } else {
      for (const a of rel.assets) step(`${a.name}  ${(a.size / 1048576).toFixed(1)} MB`);
    }
    console.log(`\nDONE  ${rel.html_url}`);
    process.exit(0);
  }
  await sleep(10000);
}

die('等待构建超时（约 15 分钟）', `去 https://github.com/${SLUG}/actions/runs/${runId} 继续看`);
