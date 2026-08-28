const fixtureOrigin = String(process.env.WOS_ENTRA_FIXTURE_ORIGIN || '').trim();
if (fixtureOrigin) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requested = new URL(input instanceof Request ? input.url : String(input));
    if (!['login.microsoftonline.com', 'login.microsoftonline.us', 'login.partner.microsoftonline.cn'].includes(requested.hostname)) {
      return originalFetch(input, init);
    }
    const target = new URL(`${requested.pathname}${requested.search}`, fixtureOrigin);
    const response = await originalFetch(target, init);
    Object.defineProperty(response, 'url', {value: requested.href});
    return response;
  };
}
