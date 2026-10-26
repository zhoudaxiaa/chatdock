// Runs in MAIN at document_start. Only ChatDock's explicitly named Claude frame
// opts in; ordinary Claude tabs, other sites and nested auth frames are untouched.
(() => {
  if (window.location.hostname !== 'claude.ai' || window.top === window) return;
  const parentOrigin = window.location.ancestorOrigins?.[0];
  const owner = /^chrome-extension:\/\/([a-p]{32})$/.exec(parentOrigin || '');
  if (!owner || window.name !== `chatdock-claude:${owner[1]}:full`) return;

  const descriptor = Object.getOwnPropertyDescriptor(window, 'self');
  if (!descriptor?.configurable || typeof descriptor.get !== 'function') return;
  // Claude currently uses self !== top to omit its full navigation shell.
  // `top` is unforgeable, so the alias is on `self`. On a cross-origin top any
  // property access (self.crypto, self.__TSR_ROUTER__ = ...) throws, so only
  // Claude's own app bundles get the alias, and its router keeps the real
  // window. Cloudflare, analytics and every other caller see the real window.
  // The options switch reloads the frame with :native to turn this off.
  const APP_BUNDLE = /^\s*at .*https:\/\/assets-proxy\.anthropic\.com\/claude-ai\//;
  const REAL_WINDOW = /vendor-router|\/router[-.]/i;
  const wantsTop = () => {
    try {
      const caller = String(new Error().stack).split('\n')[3] || '';
      return APP_BUNDLE.test(caller) && !REAL_WINDOW.test(caller);
    } catch {
      return false;
    }
  };
  Object.defineProperty(window, 'self', {
    ...descriptor,
    get: () => (wantsTop() ? window.top : window)
  });
})();
