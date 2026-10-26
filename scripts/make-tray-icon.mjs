#!/usr/bin/env node
/**
 * 生成 macOS 菜单栏（Tray）专用的 template 图标。
 *
 * 为什么不复用 icon.png：icon.png 是 512×512 的彩色圆角方块（绿底 + 白色 AI），
 * macOS 会把它整个塞进 22pt 高的菜单栏里，视觉上又大又糊，深色菜单栏下更突兀。
 * 菜单栏图标应当是「单色 + 透明背景 + 16pt 视觉尺寸」的 template image：
 * 系统会自动把它染成黑色（浅色模式）或白色（深色模式），并在选中态反色。
 *
 * 生成物（与 main.js 里的约定保持一致）：
 *   trayTemplate.png     16×16
 *   trayTemplate@2x.png  32×32
 *   trayTemplate@3x.png  48×48
 *
 * 形状：圆角对话气泡（带左下尾巴）+ 内部四角星（astroid，AI/sparkle 语义），
 * 用有向距离场（SDF）在像素中心采样做抗锯齿，不依赖任何第三方图像库。
 *
 * 用法：node scripts/make-tray-icon.mjs [--preview]
 *   --preview 额外输出 preview-tray-icon.png（放大 + 明暗双底色），用于人眼检查。
 */
import { writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop');

// ===== 设计网格：所有尺寸都按 16×16 的逻辑网格描述，再按倍率缩放 =====
const GRID = 16;

const BUBBLE = { cx: 8, cy: 6.85, hw: 6.55, hh: 5.35, r: 2.6 }; // 1.45..14.55 / 1.5..12.2
// 三个顶点都收在气泡内部（含尾巴尖的斜边与底边的交点），union 后才不会在接缝处留缺口
const TAIL = [
  [3.8, 11.3], // 上沿
  [2.55, 14.4], // 尾巴尖（朝左下）
  [8.0, 11.3] // 右沿
];
const STROKE = 1.35; // 气泡描边宽度
// p 取 0.75：比标准 astroid（2/3）胖一些；再给 0.16 的膨胀，16px 下四角才不会糊成灰点
const STAR = { cx: 8, cy: 6.85, r: 3.3, p: 0.75, grow: 0.16 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function sdRoundRect(x, y, { cx, cy, hw, hh, r }) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

// iq 的多边形 SDF（对任意简单多边形都成立）
function sdPolygon(x, y, verts) {
  let d = (x - verts[0][0]) ** 2 + (y - verts[0][1]) ** 2;
  let s = 1;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i, i++) {
    const [vix, viy] = verts[i];
    const [vjx, vjy] = verts[j];
    const ex = vjx - vix;
    const ey = vjy - viy;
    const wx = x - vix;
    const wy = y - viy;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = y >= viy;
    const c2 = y < vjy;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

// astroid 四角星的隐式函数：|x|^p + |y|^p = r^p（p<1 时向内凹成星形）
// 返回 (f - r)：形状边界上为 0，负值在内部
function starField(x, y, { cx, cy, r, p }) {
  const ax = Math.max(Math.abs(x - cx), 1e-4);
  const ay = Math.max(Math.abs(y - cy), 1e-4);
  return (ax ** p + ay ** p) ** (1 / p) - r;
}

function sdStar(x, y, star, grow) {
  // 隐式函数不是距离场，用数值梯度归一化成一阶近似的有向距离：(f-r)/|∇f|
  const h = 1e-3;
  const f0 = starField(x, y, star);
  const gx = (starField(x + h, y, star) - starField(x - h, y, star)) / (2 * h);
  const gy = (starField(x, y + h, star) - starField(x, y - h, star)) / (2 * h);
  const g = Math.max(Math.hypot(gx, gy), 1e-3);
  return f0 / g - grow; // grow：整体向外膨胀，让四角在极小尺寸下也够粗
}

// 小尺寸补正（hinting）：16px 只有 256 个像素，按原参数缩下去星会糊成一团、
// 细描边会掉成灰边。这一档把描边和星都加粗一点，保留视觉重量。
function hintOpts(size) {
  if (size > 16) return { stroke: STROKE, starGrow: STAR.grow };
  return { stroke: STROKE + 0.15, starGrow: STAR.grow + 0.08 };
}

// 整个图标的有向距离场：<0 在形状内
function sdIcon(x, y, opts = hintOpts(32)) {
  const body = Math.min(
    sdRoundRect(x, y, BUBBLE),
    sdPolygon(x, y, TAIL)
  );
  // 描边完全落在形状内侧：先把形状收缩半个描边宽，再取轮廓，
  // 这样描边的外沿正好贴在 BUBBLE 边界上，不会向外溢出一圈淡边（那会让图标显得更大）
  const outline = Math.abs(body + opts.stroke / 2) - opts.stroke / 2;
  const star = sdStar(x, y, STAR, opts.starGrow);
  return Math.min(outline, star);
}

// ===== PNG 编码（RGBA8，无滤波），只用内置 zlib =====
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

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// 用 SDF + 像素中心采样渲染：像素距离 = 网格距离 / 每像素占多少网格单位
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const unit = GRID / size;
  const opts = hintOpts(size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) * unit;
      const y = (py + 0.5) * unit;
      const dPx = sdIcon(x, y, opts) / unit; // 换算成「像素」
      const a = clamp(0.5 - dPx, 0, 1);
      const i = (py * size + px) * 4;
      rgba[i] = 0; // template image：纯黑，靠 alpha 描述形状
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, rgba);
}

// ===== 预览图：矢量放大 + 真实 16px 位图放大，分别铺浅底 / 深底，眼球校验 =====
// 解码本脚本自己产出的 PNG（全 filter=0），用于还原「真实像素」而不是矢量重采样
function decodeOwnPng(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, rgba };
}

function renderPreview() {
  const png16 = decodeOwnPng(renderIcon(16));
  const cell = 32 * 6; // 统一格子尺寸（192px）
  const pad = 8;
  // [数据源, 是否深色底]
  const tiles = [
    [png16, false],
    [png16, true],
    [null, false], // null = 直接用 SDF 矢量重采样（32pt 的效果）
    [null, true]
  ];
  const width = cell * tiles.length + pad * (tiles.length + 1);
  const height = cell + pad * 2;
  const rgba = Buffer.alloc(width * height * 4);

  tiles.forEach(([src, dark], idx) => {
    const ox = pad + idx * (cell + pad);
    const ink = dark ? 255 : 0;
    const bg = dark ? 30 : 245;
    const size = 32;
    const scale = cell / size; // 32 → 192
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        let a = 0;
        if (src) {
          // 真实位图：最近邻放大，看的就是屏幕上的真像素块
          const sx = Math.floor((x / cell) * src.width);
          const sy = Math.floor((y / cell) * src.height);
          a = src.rgba[(Math.min(sy, src.height - 1) * src.width + Math.min(sx, src.width - 1)) * 4 + 3] / 255;
        } else {
          const u = ((x + 0.5) / scale) * (GRID / size);
          const v = ((y + 0.5) / scale) * (GRID / size);
          a = clamp(0.5 - sdIcon(u, v, hintOpts(size)) / (GRID / (size * scale)), 0, 1);
        }
        const i = ((y + pad) * width + (x + ox)) * 4;
        rgba[i] = Math.round(ink * a + bg * (1 - a));
        rgba[i + 1] = Math.round(ink * a + bg * (1 - a));
        rgba[i + 2] = Math.round(ink * a + bg * (1 - a));
        rgba[i + 3] = 255;
      }
    }
  });
  return encodePng(width, height, rgba);
}

// ===== 输出 =====
const TARGETS = [
  ['trayTemplate.png', 16],
  ['trayTemplate@2x.png', 32],
  ['trayTemplate@3x.png', 48]
];

for (const [name, size] of TARGETS) {
  const file = path.join(ROOT, name);
  writeFileSync(file, renderIcon(size));
  console.log(`written ${name} (${size}x${size})`);
}

if (process.argv.includes('--preview')) {
  const file = path.join(ROOT, 'preview-tray-icon.png');
  writeFileSync(file, renderPreview());
  console.log('written preview-tray-icon.png');
}
