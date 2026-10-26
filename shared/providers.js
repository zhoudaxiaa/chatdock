// Shared by Electron (require) and extension pages/content scripts (global).
(function (root) {
  const providers = {
    chatgpt: {
      id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/',
      domains: ['chatgpt.com', 'openai.com'],
      composers: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'form [contenteditable="true"]', 'textarea[data-id="root"]', 'textarea'],
      sendButtons: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="发送"]']
    },
    claude: {
      id: 'claude', label: 'Claude', url: 'https://claude.ai/new',
      domains: ['claude.ai'],
      composers: ['[data-testid="chat-input"][contenteditable="true"]', 'div.ProseMirror[contenteditable="true"]', '[contenteditable="true"][role="textbox"]', 'textarea[aria-label="Write your prompt to Claude"]'],
      sendButtons: ['button[data-testid="chat-input-send"]', 'button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[data-testid="send-button"]', 'button[aria-label*="发送"]']
    }
  };
  function getProvider(id) { return Object.hasOwn(providers, id) ? providers[id] : providers.chatgpt; }
  function ownsDomain(id, raw) {
    const host = String(raw || '').replace(/^\./, '').toLowerCase();
    return getProvider(id).domains.some(d => host === d || host.endsWith('.' + d));
  }
  function normalizeProviderUrl(id, raw) {
    const provider = getProvider(id);
    const url = new URL(typeof raw === 'string' && raw.trim() ? raw.trim() : provider.url);
    // Existing extension permissions and composer adapters only cover these sites.
    if (url.origin !== new URL(provider.url).origin || url.username || url.password) {
      throw new Error(`${provider.label} 地址必须使用 ${new URL(provider.url).origin}`);
    }
    return url.href;
  }
  function resolveProviderUrls(stored) {
    return Object.fromEntries(Object.keys(providers).map(id => {
      try { return [id, normalizeProviderUrl(id, stored?.[id])]; }
      catch { return [id, providers[id].url]; }
    }));
  }
  const api = { providers, getProvider, ownsDomain, normalizeProviderUrl, resolveProviderUrls };
  root.ChatDockProviders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
