import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createTokenBroker, listenTokenBroker } from '../../src/token-broker.js'
import TokenClientPlugin from '../../src/token-client.js'

describe('token broker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-broker-'))
  const file = (name: string) => path.join(dir, name)
  const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' })
  let server: https.Server
  let port: number
  const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url')}.sig`

  beforeAll(async () => {
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca.key'), '-out', file('ca.crt'), '-subj', '/CN=Test CA', '-days', '1')
    for (const name of ['server', 'client']) {
      openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', file(`${name}.key`), '-out', file(`${name}.csr`), '-subj', `/CN=${name}`)
      fs.writeFileSync(file(`${name}.ext`), name === 'server' ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n')
      openssl('x509', '-req', '-in', file(`${name}.csr`), '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial', '-out', file(`${name}.crt`), '-days', '1', '-extfile', file(`${name}.ext`))
    }
    server = createTokenBroker({
      cert: fs.readFileSync(file('server.crt')),
      key: fs.readFileSync(file('server.key')),
      ca: fs.readFileSync(file('ca.crt')),
      lease: async (model, excluded) => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return excluded.has('first') ? null : { alias: 'first', accountId: 'account', accessToken: token, expiresAt: Date.now() + 60_000 }
      }
    })
    port = await listenTokenBroker(server, 0)
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const request = (body: string, client = true): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> => new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1', port, path: '/v1/token', method: 'POST', ca: fs.readFileSync(file('ca.crt')),
      ...(client ? { cert: fs.readFileSync(file('client.crt')), key: fs.readFileSync(file('client.key')) } : {})
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode || 0, body: text, headers: res.headers }))
    })
    req.on('error', reject)
    req.end(body)
  })

  it('returns only a short-lived access token to an authenticated client', async () => {
    const result = await request(JSON.stringify({ model: 'gpt-5.6-sol', excludeAliases: [] }))
    expect(result.status).toBe(200)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(result.body)).toMatchObject({ alias: 'first', accountId: 'account', accessToken: token })
    expect(result.body).not.toContain('refreshToken')
    expect((await request(JSON.stringify({ model: 'gpt-5.6-sol', excludeAliases: ['first'] }))).status).toBe(503)
    expect((await request('{}')).status).toBe(400)
  })

  it('rejects clients without a certificate', async () => {
    await expect(request(JSON.stringify({ model: 'gpt-5.6-sol', excludeAliases: [] }), false)).rejects.toThrow()
  })

  it('sends only a token request to the broker and the model request directly', async () => {
    const previous = globalThis.fetch
    const names = [
      'OPENCODE_MULTI_AUTH_TOKEN_BROKER_URL', 'OPENCODE_MULTI_AUTH_TOKEN_BROKER_CERT_PATH',
      'OPENCODE_MULTI_AUTH_TOKEN_BROKER_KEY_PATH', 'OPENCODE_MULTI_AUTH_TOKEN_BROKER_CA_PATH'
    ] as const
    const old = names.map(name => process.env[name])
    process.env[names[0]] = `https://127.0.0.1:${port}/v1/token`
    process.env[names[1]] = file('client.crt')
    process.env[names[2]] = file('client.key')
    process.env[names[3]] = file('ca.crt')
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls++
      expect(input).toBe('https://chatgpt.com/backend-api/codex/responses')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
      expect(JSON.parse(String(init?.body)).model).toBe('gpt-5.6-sol')
      return new Response('{}', { status: 200 })
    }
    let hooks: Awaited<ReturnType<typeof TokenClientPlugin>> | undefined
    try {
      hooks = await TokenClientPlugin({} as Parameters<typeof TokenClientPlugin>[0])
      const config = { provider: { openai: { models: { 'gpt-5.6-sol': {} } } } }
      await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])
      const fetcher = (config.provider.openai as { options?: { fetch: typeof fetch } }).options?.fetch
      expect(fetcher).toBeDefined()
      const result = await fetcher!('https://chatgpt.com/backend-api/responses', {
        method: 'POST', body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'example' })
      })
      expect(result.status).toBe(200)
      expect(calls).toBe(1)
    } finally {
      await hooks?.dispose?.()
      globalThis.fetch = previous
      names.forEach((name, index) => old[index] === undefined ? delete process.env[name] : process.env[name] = old[index])
    }
  })
})
