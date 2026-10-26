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
  const api = { providers, getProvider, ownsDomain };
  root.ChatDockProviders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
