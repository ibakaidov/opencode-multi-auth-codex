import http from 'node:http'
import { fetchOAuthToken } from '../../src/oauth-token-fetch.js'

describe('OAuth refresh transport', () => {
  afterEach(() => {
    delete process.env.OPENCODE_MULTI_AUTH_OAUTH_PROXY_URL
    process.env.HTTPS_PROXY = ''
    process.env.https_proxy = ''
    process.env.HTTP_PROXY = ''
    process.env.http_proxy = ''
  })

  it('uses the configured HTTPS proxy for refresh and fails closed', async () => {
    const targets: string[] = []
    const proxy = http.createServer()
    proxy.on('connect', (request, socket) => {
      targets.push(request.url || '')
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    try {
      const address = proxy.address()
      if (!address || typeof address === 'string') throw new Error('missing proxy port')
      process.env.HTTPS_PROXY = `http://127.0.0.1:${address.port}`
      await expect(fetchOAuthToken({ method: 'POST' })).rejects.toThrow()
      expect(targets).toEqual(['auth.openai.com:443'])
    } finally {
      await new Promise<void>(resolve => proxy.close(() => resolve()))
    }
  })
})
