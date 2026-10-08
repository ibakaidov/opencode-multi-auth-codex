import http from 'node:http'
import { fetchOAuthToken } from '../../src/oauth-token-fetch.js'

describe('broker OAuth refresh transport', () => {
  const oldEndpoint = process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL
  afterAll(() => {
    if (oldEndpoint === undefined) delete process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL
    else process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL = oldEndpoint
  })

  it('does not fall back to a direct OAuth request when NL CONNECT fails', async () => {
    const proxy = http.createServer()
    let target = ''
    proxy.on('connect', (request, socket) => {
      target = request.url || ''
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    try {
      const addr = proxy.address()
      if (!addr || typeof addr === 'string') throw new Error('missing proxy port')
      process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL = `http://127.0.0.1:${addr.port}`
      const original = globalThis.fetch
      let directCalls = 0
      globalThis.fetch = async () => { directCalls++; throw new Error('direct OAuth route used') }
      try {
        await expect(fetchOAuthToken({ method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token' }) })).rejects.toThrow()
        expect(target).toBe('auth.openai.com:443')
        expect(directCalls).toBe(0)
      } finally {
        globalThis.fetch = original
      }
      process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL = 'socks5://127.0.0.1:11808'
      await expect(fetchOAuthToken({ method: 'POST' })).rejects.toThrow(/HTTP CONNECT/)
    } finally {
      await new Promise<void>(resolve => proxy.close(() => resolve()))
    }
  })

  it('keeps the existing direct transport when no broker proxy is configured', async () => {
    delete process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response('{}', { status: 200 }) }
    try {
      const result = await fetchOAuthToken({ method: 'POST' })
      expect(result.status).toBe(200)
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })
})
