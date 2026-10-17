// ChatGPT Session Bridge —— 读取默认浏览器里 ChatGPT/OpenAI 的登录 Cookie，
// POST 到本机端口，由 Electron 主进程写入它自己的会话存储。
// 触发方式：① 点击扩展图标手动同步；② 扩展/浏览器启动时自动同步一次。
const ENDPOINT = 'http://127.0.0.1:32123/import-cookies';
const TOKEN = 'dsh-chatgpt-bridge-2026';
const PARENT_DOMAINS = ['chatgpt.com', 'openai.com'];

async function collectAndSend() {
  try {
    const seen = new Set();
    const cookies = [];
    for (const domain of PARENT_DOMAINS) {
      // getAll({domain}) 会同时匹配该域名及其所有子域（如 auth.openai.com）
      const list = await chrome.cookies.getAll({ domain });
      for (const c of list) {
        const key = c.domain + '\u0000' + c.name + '\u0000' + c.path;
        if (seen.has(key)) continue;
        seen.add(key);
        cookies.push(c);
      }
    }
    if (!cookies.length) {
      chrome.action.setBadgeText({ text: '0' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
      return;
    }
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-token': TOKEN
      },
      body: JSON.stringify({ cookies })
    });
    const data = await res.json();
    chrome.action.setBadgeText({ text: data.ok ? '✓' : '!' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } catch (err) {
    console.error('ChatGPT Session Bridge 同步失败:', err);
    chrome.action.setBadgeText({ text: '!' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  }
}

// 点击扩展图标手动同步
chrome.action.onClicked.addListener(collectAndSend);

// 扩展加载/浏览器启动时自动同步一次
void collectAndSend();
