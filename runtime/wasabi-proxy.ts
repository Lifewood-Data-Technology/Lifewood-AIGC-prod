/** Only storage SDK clients receive this route. Browser URLs and other outbound requests keep their own transport. */
export function readWasabiHttpProxy(value?: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/?$/.exec(value);
  if (!match || match[0] !== value || Number(match[1]) > 65535) {
    throw Error('WASABI_HTTP_PROXY requires a local HTTP proxy with an explicit loopback address and port.');
  }
  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
    throw Error('WASABI_HTTP_PROXY requires a Node.js runtime with native HTTP proxy support.');
  }
  return value;
}

export function wasabiAgentOptions(value?: string) {
  const proxy = readWasabiHttpProxy(value);
  // Smithy builds its private HTTPS agent with these options, retaining its connection pool limits.
  return proxy ? { httpsAgent: { keepAlive: true, proxyEnv: { HTTPS_PROXY: proxy, NO_PROXY: '' } } } : {};
}
