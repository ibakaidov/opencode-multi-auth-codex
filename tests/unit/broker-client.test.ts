import type { Dispatcher } from 'undici'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBrokerClient,
  getBrokerConfig,
  sanitizeBrokerError,
  sanitizeBrokerRequestHeaders,
  validateBrokerConfig
} from '../../src/broker-client.js'
import type { BrokerConfig } from '../../src/types.js'

const config: BrokerConfig = {
  enabled: true,
  url: 'https://broker.example.test/v1/responses',
  clientCertPath: '/run/secrets/client.crt',
  clientKeyPath: '/run/secrets/client.key',
  caPath: '/run/secrets/ca.crt',
  timeoutMs: 1000,
  models: ['gpt-5.6-sol']
}

describe('broker config', () => {
  it('loads and validates the production environment', () => {
    expect(getBrokerConfig({ ...config, enabled: false }, {
      OPENCODE_MULTI_AUTH_BROKER_ENABLED: 'true',
      OPENCODE_MULTI_AUTH_BROKER_URL: config.url,
      OPENCODE_MULTI_AUTH_BROKER_CERT_PATH: config.clientCertPath,
      OPENCODE_MULTI_AUTH_BROKER_KEY_PATH: config.clientKeyPath,
      OPENCODE_MULTI_AUTH_BROKER_CA_PATH: config.caPath,
      OPENCODE_MULTI_AUTH_BROKER_TIMEOUT_MS: '1500',
      OPENCODE_MULTI_AUTH_BROKER_MODELS: 'gpt-5.6-sol, private-broker-model'
    })).toEqual(expect.objectContaining({
      enabled: true,
      timeoutMs: 1500,
      models: ['gpt-5.6-sol', 'private-broker-model']
    }))
  })

  it('rejects insecure URLs and relative credential paths', () => {
    expect(() => validateBrokerConfig({ ...config, url: 'http://broker.example.test' }))
      .toThrow('must use HTTPS')
    expect(() => validateBrokerConfig({ ...config, clientKeyPath: 'client.key' }))
      .toThrow('must be an absolute path')
  })

  it('requires the exact production Responses endpoint', () => {
    for (const url of [
      'https://user@broker.example.test/v1/responses',
      'https://broker.example.test/responses',
      'https://broker.example.test/v1/responses?tenant=private',
      'https://broker.example.test/v1/responses#fragment'
    ]) {
      expect(() => validateBrokerConfig({ ...config, url })).toThrow()
    }
  })
})

describe('broker transport security', () => {
  it('constructs a fresh header set without credentials, accounts, or cookies', () => {
    const headers = sanitizeBrokerRequestHeaders({
      Authorization: 'Bearer secret',
      'x-api-key': 'secret',
      'chatgpt-account-id': 'account-id',
      Cookie: 'session=secret',
      Accept: 'application/json',
      'x-untrusted': 'value'
    })

    expect(Object.fromEntries(headers.entries())).toEqual({
      accept: 'application/json',
      'content-type': 'application/json'
    })
  })

  it('discovers models through the broker mTLS transport', async () => {
    let captured: { url?: string, init?: RequestInit & { dispatcher?: Dispatcher } } = {}
    const dispatcher = {} as Dispatcher
    const client = createBrokerClient(config, {
      dispatcher,
      fetchImpl: async (input, init) => {
        captured = { url: input.toString(), init }
        return new Response(JSON.stringify({
          data: [
            { id: 'gpt-5.6-sol' },
            { id: 'gpt-5.6-terra' },
            { id: 'gpt-5.6-luna' },
            { id: '../invalid' }
          ]
        }), { headers: { 'content-type': 'application/json' } })
      }
    })

    await expect(client.models()).resolves.toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
    ])
    expect(captured.url).toBe('https://broker.example.test/v1/models')
    expect(captured.init?.method).toBe('GET')
    expect(captured.init?.dispatcher).toBe(dispatcher)
    expect(Object.fromEntries(new Headers(captured.init?.headers).entries())).toEqual({ accept: 'application/json' })
  })

  it('posts JSON through the supplied undici dispatcher and sanitizes broker errors', async () => {
    let captured: { url?: string; init?: RequestInit & { dispatcher?: Dispatcher } } = {}
    const dispatcher = {} as Dispatcher
    const client = createBrokerClient(config, {
      dispatcher,
      fetchImpl: async (input, init) => {
        captured = { url: input.toString(), init }
        return new Response(JSON.stringify({
          error: { code: 'UPSTREAM_FAILED', message: 'safe detail' },
          alias: 'private-alias',
          account_id: 'private-account',
          request_id: 'request-123'
        }), {
          status: 409,
          headers: {
            'content-type': 'application/json',
            'retry-after': '10',
            'set-cookie': 'session=secret'
          }
        })
      }
    })

    const response = await client.request({ model: 'gpt-5.6-sol', store: false }, {
      headers: { Authorization: 'Bearer secret', Cookie: 'secret' }
    })
    const body = await response.json() as Record<string, unknown>

    expect(captured.url).toBe(config.url)
    expect(captured.init?.dispatcher).toBe(dispatcher)
    expect(captured.init?.method).toBe('POST')
    expect(captured.init?.redirect).toBe('error')
    expect(JSON.parse(captured.init?.body as string)).toEqual({ model: 'gpt-5.6-sol', store: false })
    expect(Object.fromEntries(new Headers(captured.init?.headers).entries())).toEqual({
      accept: 'text/event-stream',
      'content-type': 'application/json'
    })
    expect(response.status).toBe(409)
    expect(response.headers.get('retry-after')).toBe('10')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(body).toEqual({
      error: { code: 'UPSTREAM_FAILED', message: 'safe detail' },
      request_id: 'request-123'
    })
  })

  it('returns the first retryable broker response', async () => {
    let calls = 0
    const client = createBrokerClient(config, {
      dispatcher: {} as Dispatcher,
      fetchImpl: async () => {
        calls += 1
        return new Response('{}', { status: 503, headers: { 'retry-after': '0' } })
      }
    })

    const response = await client.request({ model: 'gpt-5.6-sol' })
    expect(response.status).toBe(503)
    expect(calls).toBe(1)
  })

  it('does not retry a retryable broker response', async () => {
    let calls = 0
    const client = createBrokerClient(config, {
      dispatcher: {} as Dispatcher,
      fetchImpl: async () => {
        calls += 1
        return new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'retry later' } }), {
          status: 503,
          headers: { 'retry-after': '0', 'content-type': 'application/json' }
        })
      }
    })

    const response = await client.request({ model: 'gpt-5.6-sol' })
    expect(response.status).toBe(503)
    expect(calls).toBe(1)
  })

  it('uses Bun native TLS instead of an undici dispatcher in the support image runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-bun-tls-'))
    const runtimeConfig = {
      ...config,
      clientCertPath: path.join(root, 'client.crt'),
      clientKeyPath: path.join(root, 'client.key'),
      caPath: path.join(root, 'ca.crt')
    }
    for (const pathname of [runtimeConfig.clientCertPath, runtimeConfig.clientKeyPath, runtimeConfig.caPath]) {
      fs.writeFileSync(pathname, 'pem')
    }
    let captured: { init?: RequestInit & { dispatcher?: Dispatcher; tls?: Record<string, unknown> } } = {}
    const bun = {}
    const client = createBrokerClient(runtimeConfig, {
      bun,
      fetchImpl: async (_input, init) => {
        captured = { init }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
    })

    try {
      await client.request({ model: 'gpt-5.6-sol', store: false })
      expect(captured.init?.dispatcher).toBeUndefined()
      expect(captured.init?.tls).toEqual({
        cert: Buffer.from('pem'),
        key: Buffer.from('pem'),
        ca: [Buffer.from('pem')],
        rejectUnauthorized: true
      })
    } finally {
      await client.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a custom fetch on the undici transport unless Bun is explicitly selected', async () => {
    const dispatcher = {} as Dispatcher
    let captured: (RequestInit & { dispatcher?: Dispatcher; tls?: Record<string, unknown> }) | undefined
    const client = createBrokerClient(config, {
      dispatcher,
      fetchImpl: async (_input, init) => {
        captured = init
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
    })

    await client.request({ model: 'gpt-5.6-sol' })
    expect(captured?.dispatcher).toBe(dispatcher)
    expect(captured?.tls).toBeUndefined()
  })

  it('removes sensitive nested error details', () => {
    expect(sanitizeBrokerError({
      error: {
        message: 'failed account_id=snake accountId=camel access_token=one accessToken=two',
        code: 'UPSTREAM_FAILED',
        details: { harmless: 'not allowlisted' }
      },
      request_id: 'request-123',
      arbitrary: 'not allowlisted',
      token: 'secret'
    })).toEqual({
      error: {
        message: 'failed account_id=[redacted] accountId=[redacted] access_token=[redacted] accessToken=[redacted]',
        code: 'UPSTREAM_FAILED'
      },
      request_id: 'request-123'
    })
  })

  it('bounds broker error bodies before sanitizing them', async () => {
    const client = createBrokerClient(config, {
      dispatcher: {} as Dispatcher,
      fetchImpl: async () => new Response('x'.repeat(64 * 1024 + 1), { status: 409 })
    })

    const response = await client.request({ model: 'gpt-5.6-sol' })
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'BROKER_ERROR_BODY_TOO_LARGE',
        message: 'Broker error response exceeded the size limit'
      }
    })
  })

  it('sanitizes error events returned inside successful SSE streams', async () => {
    const client = createBrokerClient(config, {
      dispatcher: {} as Dispatcher,
      fetchImpl: async () => new Response(
        'data: {"type":"response.created","response":{"id":"safe"}}\n\n' +
        'data: {"type":"response.failed","response":{"error":{"code":"FAILED","message":"token=secret"}},"account_id":"secret"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    })

    const response = await client.request({ model: 'gpt-5.6-sol' })
    expect(await response.text()).toBe(
      'data: {"type":"response.created","response":{"id":"safe"}}\n\n' +
      'data: {"type":"response.failed","error":{"code":"FAILED","message":"token=[redacted]"}}\n\n'
    )
  })

  it('resets the SSE idle timeout when chunks arrive', async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode('data: one\n\n'))
        await new Promise(resolve => setTimeout(resolve, 15))
        controller.enqueue(encoder.encode('data: two\n\n'))
        await new Promise(resolve => setTimeout(resolve, 15))
        controller.close()
      }
    })
    const client = createBrokerClient({ ...config, timeoutMs: 25 }, {
      dispatcher: {} as Dispatcher,
      fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })

    const response = await client.request({ model: 'gpt-5.6-sol' })
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n')
  })

  it('returns a fixed SSE event when a successful stream goes idle', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'))
      }
    })
    const client = createBrokerClient({ ...config, timeoutMs: 10 }, {
      dispatcher: {} as Dispatcher,
      fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })

    const response = await client.request({ model: 'gpt-5.6-sol' })
    expect(await response.text()).toBe(
      'data: first\n\n' +
      'data: {"type":"error","error":{"code":"BROKER_STREAM_TIMEOUT","message":"Broker stream timed out while idle"}}\n\n'
    )
  })

  it('preserves caller cancellation instead of converting it to a broker error', async () => {
    const controller = new AbortController()
    const client = createBrokerClient(config, {
      dispatcher: {} as Dispatcher,
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    })
    const request = client.request({ model: 'gpt-5.6-sol' }, { signal: controller.signal })
    controller.abort(new DOMException('caller cancelled', 'AbortError'))

    await expect(request).rejects.toMatchObject({ name: 'AbortError', message: 'caller cancelled' })
  })
})
