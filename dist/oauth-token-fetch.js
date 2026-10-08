import { ProxyAgent, fetch as undiciFetch } from 'undici';
export const TOKEN_URL = 'https://auth.openai.com/oauth/token';
let proxyAgent = null;
let proxyEndpoint = null;
// OpenCode's HTTPS proxy is the approved OAuth egress unless explicitly overridden.
export async function fetchOAuthToken(init) {
    const endpoint = process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL?.trim() ||
        process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim() ||
        process.env.HTTP_PROXY?.trim() || process.env.http_proxy?.trim();
    if (!endpoint)
        return fetch(TOKEN_URL, init);
    let parsed;
    try {
        parsed = new URL(endpoint);
    }
    catch {
        throw new Error('Invalid OAuth egress proxy URL');
    }
    if (parsed.protocol !== 'http:' || !parsed.hostname || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('OAuth egress proxy must be an unauthenticated HTTP CONNECT endpoint');
    }
    if (proxyEndpoint !== null && proxyEndpoint !== parsed.href) {
        throw new Error('Restart the OpenCode process to change its OAuth egress proxy');
    }
    proxyAgent ??= new ProxyAgent(parsed.href);
    proxyEndpoint = parsed.href;
    const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000);
    return undiciFetch(TOKEN_URL, {
        ...init,
        dispatcher: proxyAgent,
        redirect: 'error',
        signal
    });
}
//# sourceMappingURL=oauth-token-fetch.js.map