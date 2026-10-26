// preload：只把「对话正文里」点到的外部链接转发给主进程用默认浏览器打开
// 其余链接一律不管，保持页面默认行为。
const { ipcRenderer } = require('electron');

// 存活探针：主进程/诊断工具可通过 localStorage 键确认本脚本已执行
try { localStorage.setItem('__chatgpt_shell_bridge', '1'); } catch {}

// 内部域名判断：chatgpt 本体 + 登录用的 openai 域名，站内链接不做任何处理
function isInternalURL(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'chatgpt.com'
      || host.endsWith('.chatgpt.com')
      || host === 'openai.com'
      || host.endsWith('.openai.com')
      || host === 'claude.ai' || host.endsWith('.claude.ai');
  } catch { return false; }
}

// 判断一个元素是否位于对话正文里（消息内容区块）
// 新版 ChatGPT UI 换掉了旧的 data-message-author-role / conversation-turn，
// 现在用 data-turn-key / data-dil-message-id / data-chatgpt-search-unit-key 等标记，
// 这里新旧一起兼容。
function isInConversation(el) {
  let node = el;
  while (node && node !== document.body) {
    if (node.getAttribute) {
      // 新版 UI 消息容器标记
      if (node.hasAttribute('data-turn-key')
          || node.hasAttribute('data-dil-message-id')
          || node.hasAttribute('data-chatgpt-search-unit-key')
          || node.hasAttribute('data-chatgpt-search-message-ids')
          || node.hasAttribute('data-chatgpt-selection-message-id')
          // 旧版 UI 消息容器标记
          || node.hasAttribute('data-message-author-role')) {
        return true;
      }
      const testid = node.getAttribute('data-testid') || '';
      if (testid.startsWith('conversation-turn') || testid === 'user-message' || testid === 'ai-message' || node.classList?.contains('font-claude-response')) {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

// 捕获阶段监听点击（不限 a[href]，href 缺失但带其他链接属性的也尽量识别）
document.addEventListener('click', (event) => {
  const anchor = event.target && event.target.closest
    ? event.target.closest('a')
    : null;
  if (!anchor) return;

  const url = anchor.href
    || (anchor.getAttribute && anchor.getAttribute('href'))
    || '';
  if (!url || isInternalURL(url)) return;   // 站内链接不动
  if (!isInConversation(anchor)) return;    // 只处理对话正文里的链接

  event.preventDefault();
  event.stopPropagation();
  // 带时间戳上报：主进程据此拦截随后可能出现的 window.open（ChatGPT 有时会 JS 打开）
  ipcRenderer.send('open-external', { url, ts: Date.now() });
}, true);