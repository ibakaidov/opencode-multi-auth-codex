import http from 'node:http'
import {jest} from '@jest/globals'

async function fetchOAuthToken(init: RequestInit): Promise<Response> {
  const plugin = await import('../../src/oauth-token-fetch.js')
  return plugin.fetchOAuthToken(init)
}

describe('broker OAuth refresh transport', () => {
  const oldEndpoint = process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL
  const oldHttpsProxy = process.env.HTTPS_PROXY
  const oldLowerHttpsProxy = process.env.https_proxy
  afterAll(() => {
    if (oldEndpoint === undefined) delete process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL
    else process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL = oldEndpoint
    if (oldHttpsProxy === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = oldHttpsProxy
    if (oldLowerHttpsProxy === undefined) delete process.env.https_proxy
    else process.env.https_proxy = oldLowerHttpsProxy
  })
  beforeEach(() => jest.resetModules())

  it('keeps the existing direct transport when no broker proxy is configured', async () => {
    delete process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL
    delete process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = ''
    process.env.https_proxy = ''
    process.env.HTTP_PROXY = ''
    process.env.http_proxy = ''
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async (_input, _init) => { calls++; return new Response('{}', { status: 200 }) }
    try {
      const result = await fetchOAuthToken({ method: 'POST' })
      expect(result.status).toBe(200)
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })

  it('does not fall back to a direct OAuth request when NL CONNECT fails', async () => {
    const targets: string[] = []
    const proxy = http.createServer()
    proxy.on('connect', (request, socket) => {
      targets.push(request.url || '')
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
        expect(targets).toEqual(['auth.openai.com:443'])
        expect(directCalls).toBe(0)
      } finally {
        globalThis.fetch = original
      }
      process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL = 'socks5://127.0.0.1:11808'
      await expect(fetchOAuthToken({ method: 'POST' })).rejects.toThrow(/HTTP CONNECT/)
      delete process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL
      process.env.HTTPS_PROXY = `http://127.0.0.1:${addr.port}`
      await expect(fetchOAuthToken({method: 'POST'})).rejects.toThrow()
      expect(targets).toEqual(['auth.openai.com:443', 'auth.openai.com:443'])
    } finally {
      await new Promise<void>(resolve => proxy.close(() => resolve()))
    }
  })

})
