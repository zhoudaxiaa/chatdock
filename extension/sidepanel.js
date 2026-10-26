const { providers, getProvider } = globalThis.ChatDockProviders;
const container = document.getElementById('container');
const overlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const retryBtn = document.getElementById('loading-retry');
const notification = document.getElementById('notification');
const notificationText = document.getElementById('notification-text');
const frames = new Map();
let active = 'chatgpt';
let pendingId = null;
let notificationTimer;
let slowTimer;
let ackTimer;
let switching = false;

function notify(text, duration = 4000) {
  clearTimeout(notificationTimer);
  notificationText.textContent = text;
  notification.classList.remove('hidden');
  if (duration) notificationTimer = setTimeout(() => notification.classList.add('hidden'), duration);
}
document.getElementById('dismiss-notification').addEventListener('click', () => notification.classList.add('hidden'));
document.getElementById('loading-version').textContent = `v${chrome.runtime.getManifest().version}`;

function showLoading() {
  clearTimeout(slowTimer);
  const state = frames.get(active);
  overlay.classList.toggle('hidden', !!state?.ready);
  overlay.classList.remove('is-done');
  retryBtn.classList.add('hidden');
  loadingText.textContent = `正在打开 ${getProvider(active).label}…`;
  if (!state?.ready) slowTimer = setTimeout(() => {
    loadingText.textContent = `${getProvider(active).label} 尚未就绪。可重试，或在新标签页完成登录。`;
    retryBtn.classList.remove('hidden');
  }, 12000);
}

// Only remove frame restrictions for documents initiated by this extension or
// the two services themselves; don't change unrelated sites' embedded frames.
async function configureFrames() {
  const template = await (await fetch(chrome.runtime.getURL('rules.json'))).json();
  const rules = template.map(rule => ({ ...rule, condition: {
    ...rule.condition, initiatorDomains: [chrome.runtime.id, 'chatgpt.com', 'openai.com', 'claude.ai']
  } }));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(r => r.id), addRules: rules });
}

function getFrame(id) {
  if (frames.has(id)) return frames.get(id);
  const frame = document.createElement('iframe');
  frame.className = 'provider-frame';
  frame.title = getProvider(id).label;
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  const state = { frame, ready: false, theme: '' };
  frames.set(id, state);
  container.insertBefore(frame, overlay);
  frame.src = getProvider(id).url;
  return state;
}

async function selectProvider(id, persist = true) {
  if (!Object.hasOwn(providers, id) || switching) return;
  switching = true;
  try {
    // Persist first so a hidden provider can't consume the new delivery.
    if (persist) await chrome.storage.local.set({ activeProvider: id });
    active = id;
    const selected = getFrame(id);
    frames.forEach((state, key) => { state.frame.hidden = key !== id; });
    document.querySelectorAll('[data-provider]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.provider === id)));
    if (selected.theme) document.documentElement.dataset.theme = selected.theme;
    else delete document.documentElement.dataset.theme;
    clearTimeout(ackTimer);
    pendingId = null;
    notification.classList.add('hidden');
    showLoading();
    await restoreDelivery();
  } catch (err) {
    notify('切换失败：' + err.message, 6000);
  } finally { switching = false; }
}

document.querySelectorAll('[data-provider]').forEach(btn => btn.addEventListener('click', () => { void selectProvider(btn.dataset.provider); }));
document.getElementById('open-tab').addEventListener('click', () => chrome.tabs.create({ url: getProvider(active).url }));
document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
retryBtn.addEventListener('click', () => {
  const state = frames.get(active);
  state.ready = false;
  state.frame.src = getProvider(active).url;
  showLoading();
});

window.addEventListener('message', event => {
  const message = event.data;
  const id = message?.provider;
  const state = frames.get(id);
  if (!state || event.source !== state.frame.contentWindow || event.origin !== new URL(getProvider(id).url).origin) return;
  if (message.type === 'PROVIDER_READY') {
    state.ready = true;
    if (id === active) { clearTimeout(slowTimer); overlay.classList.add('hidden'); }
  } else if (message.type === 'PROVIDER_THEME' && ['dark', 'light'].includes(message.theme)) {
    state.theme = message.theme;
    if (id === active) document.documentElement.dataset.theme = message.theme;
  }
});

function delivered(payload) {
  if (!payload?.id || !payload.text || (payload.provider || 'chatgpt') !== active || Date.now() - payload.ts > 30000) return;
  pendingId = payload.id;
  clearTimeout(ackTimer);
  notify(`正在填入 ${getProvider(active).label}：“${payload.preview || payload.text.slice(0, 42)}”`, 0);
  ackTimer = setTimeout(() => {
    if (pendingId !== payload.id) return;
    pendingId = null;
    notify('尚未收到输入框确认，请等待页面就绪后重试。', 6000);
  }, 25000);
}
function acknowledge(ack) {
  if (!ack?.id || (ack.provider || 'chatgpt') !== active || (pendingId && ack.id !== pendingId)) return;
  if (Date.now() - (ack.ts || 0) > 30000) return;
  clearTimeout(ackTimer);
  pendingId = null;
  notify(ack.ok ? `已填入输入框：“${ack.preview || ''}”` : '未能填入输入框，请确认已经登录并等待页面就绪。', ack.ok ? 3200 : 6000);
}
async function restoreDelivery() {
  const all = await chrome.storage.local.get(null);
  const items = Object.keys(all).filter(key => key.startsWith('paste:')).map(key => all[key])
    .filter(item => (item.provider || 'chatgpt') === active && Date.now() - item.ts <= 30000)
    .sort((a, b) => a.ts - b.ts);
  if (items.length) delivered(items.at(-1));
  if (all.pendingPasteAck) acknowledge(all.pendingPasteAck);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.activeProvider?.newValue && changes.activeProvider.newValue !== active) void selectProvider(changes.activeProvider.newValue, false);
  Object.keys(changes).filter(key => key.startsWith('paste:')).forEach(key => delivered(changes[key].newValue));
  if (changes.pendingPasteAck?.newValue) acknowledge(changes.pendingPasteAck.newValue);
});

(async () => {
  try {
    await configureFrames();
    const { activeProvider } = await chrome.storage.local.get('activeProvider');
    await selectProvider(getProvider(activeProvider).id, false);
  } catch (err) {
    loadingText.textContent = '侧边栏初始化失败：' + err.message;
  }
})();
