#!/usr/bin/env node
/**
 * Publish this project to GitHub (zhoudaxiaa/chatgpt-electron).
 *
 * What it does, in order:
 *   1. Probe the environment (git availability, icon.png dimensions).
 *   2. Generate build/icon.png (1024x1024) when the root icon.png is too small
 *      for electron-builder (mac icns requires >=512px; win ico >=256px).
 *   3. Initialize the git repo (if needed), commit all tracked files, push main.
 *   4. Tag v1.0.0 and push the tag (triggers the Build & Release workflow).
 *
 * Credentials are intentionally NOT handled here: git push uses whatever
 * credential helper is configured on this machine. GIT_TERMINAL_PROMPT=0 makes
 * a missing credential fail fast instead of hanging on a prompt.
 */
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REPO_URL = 'https://github.com/zhoudaxiaa/chatgpt-electron.git';
const GIT_USER = 'zhoudaxiaa';
const GIT_EMAIL = '22782052+zhoudaxiaa@users.noreply.github.com';
const TAG = 'v1.0.0';
const COMMIT_MSG = 'feat: init ChatGPT desktop shell (electron) with CI build & release';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const log = (m) => console.log(`\n==> ${m}`);

function run(cmd, args, opts = {}) {
  const ps = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...GIT_ENV, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  const out = (ps.stdout || '').trim();
  const err = (ps.stderr || '').trim();
  if (out) console.log(out);
  if (err) console.error(err);
  if ((ps.error && ps.error.code === 'ENOENT') || ps.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${ps.status ?? ps.error?.code ?? '?'}): ${err || ps.error?.message || ''}`);
  }
  return out;
}

function pngSize(p) {
  const b = readFileSync(p);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/* ---------------- pure-node PNG encoder (RGBA, 8-bit) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, colorAt) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = colorAt(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------ draw a simple branded placeholder icon ------------ */

function drawPlaceholderIcon(size) {
  const S = size;
  // Supersample 2x2 per pixel for smooth edges.
  const colorAt = (px, py) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (const sx of [0.25, 0.75]) {
      for (const sy of [0.25, 0.75]) {
        const [cr, cg, cb, ca] = sample(Math.min(S - 1, px + sx), Math.min(S - 1, py + sy), S);
        r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
      }
    }
    return a === 0
      ? [0, 0, 0, 0]
      : [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / 4)];
  };

  const sample = (x, y, s) => {
    const inRoundRect = (px, py, x0, y0, x1, y1, rad) => {
      const cx = Math.max(x0 + rad, Math.min(px, x1 - rad));
      const cy = Math.max(y0 + rad, Math.min(py, y1 - rad));
      const dx = px - cx, dy = py - cy;
      return (dx * dx + dy * dy) <= rad * rad;
    };
    const inCircle = (px, py, cx, cy, rad) => {
      const dx = px - cx, dy = py - cy;
      return dx * dx + dy * dy <= rad * rad;
    };
    const inTriangle = (px, py, ax, ay, bx, by, cx, cy) => {
      const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
    };

    // Background: rounded square, vertical dark gradient (#0f172a -> #1e3a8a)
    if (inRoundRect(x, y, 32, 32, s - 32, s - 32, s * 0.16)) {
      const t = y / s;
      const r = Math.round(0x0f + (0x1e - 0x0f) * t);
      const g = Math.round(0x17 + (0x3a - 0x17) * t);
      const b = Math.round(0x2a + (0x8a - 0x2a) * t);
      // Speech bubble: white rounded blob
      if (inRoundRect(x, y, s * 0.24, s * 0.22, s * 0.76, s * 0.62, s * 0.11)
        && !inRoundRect(x, y, s * 0.30, s * 0.28, s * 0.70, s * 0.56, s * 0.08)) {
        return [245, 247, 250, 255];
      }
      // Bubble tail
      if (inTriangle(x, y, s * 0.42, s * 0.60, s * 0.36, s * 0.78, s * 0.56, s * 0.62)) {
        return [245, 247, 250, 255];
      }
      // ChatGPT-style accent dots inside the bubble
      for (const cx of [s * 0.40, s * 0.50, s * 0.60]) {
        if (inCircle(x, y, cx, s * 0.42, s * 0.035)) {
          return [16, 185, 129, 255]; // green accent
        }
      }
      return [r, g, b, 255];
    }
    return [0, 0, 0, 0]; // transparent outside rounded square
  };

  return encodePng(S, S, colorAt);
}

/* ---------------- main ---------------- */

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`\n!! ${msg}`);
};

// 1. environment probe
log('Environment probe');
try {
  const gitVer = run('git', ['--version']);
  log(`git available: ${gitVer}`);
} catch (e) {
  fail(`git is NOT available on this host: ${e.message}`);
}
const iconStats = existsSync(path.join(ROOT, 'icon.png')) ? statSync(path.join(ROOT, 'icon.png')) : null;
const iconDims = existsSync(path.join(ROOT, 'icon.png')) ? pngSize(path.join(ROOT, 'icon.png')) : null;
if (iconStats) {
  log(`icon.png: ${iconDims ? `${iconDims.w}x${iconDims.h}px` : 'unreadable/not a png'} (${iconStats.size} bytes)`);
} else {
  fail('icon.png missing at project root (main.js references it for tray/window icon)');
}

// 2. generate build/icon.png when the root icon is too small for packaging
const buildPng = path.join(ROOT, 'build', 'icon.png');
if (!failed) {
  const needGen = !iconDims || iconDims.w < 512 || iconDims.h < 512;
  if (needGen) {
    log(`Generating placeholder build/icon.png (1024x1024) — root icon is ${iconDims ? `${iconDims.w}x${iconDims.h}` : 'missing'}`);
    mkdirSync(path.join(ROOT, 'build'), { recursive: true });
    writeFileSync(buildPng, drawPlaceholderIcon(1024));
    log(`build/icon.png written (${statSync(buildPng).size} bytes)`);
  } else {
    log(`build/icon.png not needed — root icon is >= 512px`);
  }
}

// 3. git init / commit / push
if (!failed) {
  log('Preparing git repository');
  if (!existsSync(path.join(ROOT, '.git'))) {
    run('git', ['init']);
  }
  try {
    run('git', ['branch', '-m', 'main']);
  } catch {
    run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  // Repo-local identity (never touches global config)
  run('git', ['config', 'user.name', GIT_USER]);
  run('git', ['config', 'user.email', GIT_EMAIL]);
  run('git', ['config', 'core.autocrlf', 'false']);

  const remotes = run('git', ['remote', '-v']);
  if (!remotes.includes('origin')) {
    run('git', ['remote', 'add', 'origin', REPO_URL]);
  }

  run('git', ['add', '-A']);
  try {
    run('git', ['commit', '-m', COMMIT_MSG]);
  } catch (e) {
    if (!/nothing to commit|no changes added|nothing added/i.test(e.message)) throw e;
    log('Nothing to commit — continuing');
  }

  log('Pushing main …');
  run('git', ['push', '-u', 'origin', 'main']);

  log(`Tagging ${TAG} and pushing …`);
  run('git', ['tag', '-f', TAG]);
  run('git', ['push', '-f', 'origin', TAG]);
}

// 4. summary
console.log('\n========================================');
if (failed) {
  console.log('PUBLISH: FAILED — see errors above.');
  process.exitCode = 1;
} else {
  console.log('PUBLISH: OK');
  console.log(`  repo:   ${REPO_URL}`);
  console.log(`  branch: main`);
  console.log(`  tag:    ${TAG} (triggers "Build & Release" workflow → attaches Win x64 + macOS arm64 packages to the release page)`);
}
console.log('========================================');