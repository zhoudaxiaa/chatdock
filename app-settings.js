// 应用设置：快捷键定义 / 校验 / 匹配 + 配置文件读写
// 只依赖 Node 内置模块，主进程和单元测试都能直接 require。
'use strict';

const fs = require('fs');
const path = require('path');

const IS_MAC = process.platform === 'darwin';

// ===== 可配置的功能快捷键 =====
// scope: 'global' = 全局热键（任何应用中都能触发）；'window' = 仅应用窗口获得焦点时有效
const ACTIONS = [
  {
    id: 'toggleWindow',
    label: '唤起 / 隐藏窗口',
    desc: '在任何应用中都可触发',
    scope: 'global',
    default: 'Control+Space'
  },
  {
    id: 'screenshot',
    label: '区域截图',
    desc: '在任何应用中都可触发，框选后复制到剪贴板',
    scope: 'global',
    default: 'Control+Alt+A'
  },
  {
    id: 'quit',
    label: '退出应用',
    desc: '仅在应用窗口获得焦点时有效',
    scope: 'window',
    default: 'Control+Q'
  }
];

function defaultSettings() {
  const shortcuts = {};
  for (const a of ACTIONS) shortcuts[a.id] = a.default;
  return {
    shortcuts,
    hideWindowOnCapture: true,     // 截图时先隐藏本应用窗口，避免把自己截进去
    autoPasteAfterCapture: true    // 截图确认后自动唤起窗口并粘贴到输入框
  };
}

// ===== 快捷键解析 =====
function modifierName(token) {
  switch (token.toLowerCase()) {
    case 'control': case 'ctrl': return 'Control';
    case 'alt': case 'option': return 'Alt';
    case 'shift': return 'Shift';
    case 'meta': case 'super': case 'command': case 'cmd': return 'Meta';
    case 'commandorcontrol': case 'cmdorctrl': return IS_MAC ? 'Meta' : 'Control';
    default: return null;
  }
}

const NAMED_KEYS = {
  space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', return: 'Return', enter: 'Return',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  esc: 'Esc', escape: 'Esc', plus: 'Plus'
};
const PUNCTUATION = '-=[]\\;\',./`';

function keyName(token) {
  if (token.length === 1) {
    const upper = token.toUpperCase();
    if (/^[A-Z0-9]$/.test(upper)) return upper;
    if (PUNCTUATION.includes(token)) return token;
    return null;
  }
  const lower = token.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  const m = /^f(\d{1,2})$/.exec(lower);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 24) return 'F' + n;
  }
  return null;
}

// 'Ctrl+Alt+a' -> { mods: {Control,Alt,Shift,Meta}, key: 'A' }；无法解析返回 null
function parseAccelerator(str) {
  if (typeof str !== 'string') return null;
  const parts = str.split('+').map(s => s.trim());
  if (parts.length === 0 || parts.some(p => !p)) return null;
  const key = keyName(parts[parts.length - 1]);
  if (!key) return null;
  const mods = { Control: false, Alt: false, Shift: false, Meta: false };
  for (const p of parts.slice(0, -1)) {
    const m = modifierName(p);
    if (!m) return null;
    mods[m] = true;
  }
  return { mods, key };
}

function formatAccelerator(parsed) {
  return ['Control', 'Alt', 'Shift', 'Meta']
    .filter(m => parsed.mods[m])
    .concat(parsed.key)
    .join('+');
}

// 校验单个快捷键：必须能解析，且带修饰键（F1~F24 除外，否则会吞掉正常打字）
function validateAccelerator(str) {
  const parsed = parseAccelerator(str);
  if (!parsed) return { ok: false, error: '快捷键格式无效' };
  const hasMod = Object.values(parsed.mods).some(Boolean);
  if (!hasMod && !/^F\d+$/.test(parsed.key)) {
    return { ok: false, error: '至少需要包含一个修饰键（Ctrl / Alt / Shift）' };
  }
  return { ok: true, value: formatAccelerator(parsed) };
}

// 校验整份设置，返回规范化后的副本
function validateSettings(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '设置数据无效' };
  const defaults = defaultSettings();
  const shortcuts = {};
  const seen = new Map();
  for (const a of ACTIONS) {
    const r = validateAccelerator(raw.shortcuts && raw.shortcuts[a.id]);
    if (!r.ok) return { ok: false, error: `「${a.label}」：${r.error}` };
    if (seen.has(r.value)) {
      return { ok: false, error: `「${a.label}」与「${seen.get(r.value)}」使用了相同的快捷键` };
    }
    seen.set(r.value, a.label);
    shortcuts[a.id] = r.value;
  }
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    ok: true,
    value: {
      shortcuts,
      hideWindowOnCapture: bool(raw.hideWindowOnCapture, defaults.hideWindowOnCapture),
      autoPasteAfterCapture: bool(raw.autoPasteAfterCapture, defaults.autoPasteAfterCapture)
    }
  };
}

// ===== 窗口内快捷键匹配（用于 before-input-event）=====
const EVENT_KEY = {
  Space: ' ', Up: 'arrowup', Down: 'arrowdown', Left: 'arrowleft', Right: 'arrowright',
  Return: 'enter', Esc: 'escape', PageUp: 'pageup', PageDown: 'pagedown', Plus: '+'
};

function matchesAccelerator(input, accel) {
  const parsed = parseAccelerator(accel);
  if (!parsed || !input) return false;
  const { mods, key } = parsed;
  if (!!input.control !== mods.Control) return false;
  if (!!input.alt !== mods.Alt) return false;
  if (!!input.shift !== mods.Shift) return false;
  if (!!input.meta !== mods.Meta) return false;

  const expectedKey = EVENT_KEY[key] || key.toLowerCase();
  if (String(input.key || '').toLowerCase() === expectedKey) return true;
  // 带 Shift/Alt 时 input.key 会变成别的字符（如 Shift+1 -> '!'），再用物理键位兜底
  let expectedCode = null;
  if (/^[A-Z]$/.test(key)) expectedCode = 'Key' + key;
  else if (/^[0-9]$/.test(key)) expectedCode = 'Digit' + key;
  else if (/^F\d+$/.test(key)) expectedCode = key;
  return !!expectedCode && input.code === expectedCode;
}

// ===== 配置文件读写 =====
function loadSettings(file) {
  const defaults = defaultSettings();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return defaults;     // 文件不存在 / 损坏 -> 用默认值
  }
  const merged = {
    shortcuts: { ...defaults.shortcuts, ...(raw && raw.shortcuts) },
    hideWindowOnCapture: raw && raw.hideWindowOnCapture,
    autoPasteAfterCapture: raw && raw.autoPasteAfterCapture
  };
  const r = validateSettings(merged);
  if (r.ok) return r.value;
  // 快捷键部分有问题（被手改坏 / 冲突）：快捷键回退默认，其余开关尽量保留
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    shortcuts: defaults.shortcuts,
    hideWindowOnCapture: bool(merged.hideWindowOnCapture, defaults.hideWindowOnCapture),
    autoPasteAfterCapture: bool(merged.autoPasteAfterCapture, defaults.autoPasteAfterCapture)
  };
}

function saveSettings(file, settings) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, file);       // 先写临时文件再改名，避免写一半断电留下坏文件
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  ACTIONS,
  defaultSettings,
  parseAccelerator,
  validateAccelerator,
  validateSettings,
  matchesAccelerator,
  loadSettings,
  saveSettings
};
