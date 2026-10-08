import { ProxyAgent, fetch as undiciFetch } from 'undici'

export const TOKEN_URL = 'https://auth.openai.com/oauth/token'
let proxyAgent: ProxyAgent | null = null
let proxyEndpoint: string | null = null

// The server broker must refresh via the allowlisted NL CONNECT proxy. When
// configured, a proxy error never falls back to the blocked direct route.
export async function fetchOAuthToken(init: RequestInit): Promise<Response> {
  const endpoint = process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL?.trim()
  if (!endpoint) return fetch(TOKEN_URL, init)

  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error('Invalid OAuth egress proxy URL')
  }
  if (parsed.protocol !== 'http:' || !parsed.hostname || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('OAuth egress proxy must be an unauthenticated HTTP CONNECT endpoint')
  }
  if (proxyEndpoint !== null && proxyEndpoint !== parsed.href) {
    throw new Error('Restart the token broker to change its OAuth egress proxy')
  }
  proxyAgent ??= new ProxyAgent(parsed.href)
  proxyEndpoint = parsed.href
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000)
  return undiciFetch(TOKEN_URL, {
    ...init,
    dispatcher: proxyAgent,
    redirect: 'error',
    signal
  }) as unknown as Response
}
