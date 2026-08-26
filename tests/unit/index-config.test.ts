import path from 'node:path'
import { jest } from '@jest/globals'
import MultiAuthPlugin from '../../src/index.js'
import { BROKER_TRANSPORT_API_KEY, createBrokerFetch } from '../../src/broker-fetch.js'
import { transformResponsesPayload } from '../../src/responses.js'
import { DEFAULT_CONFIG } from '../../src/types.js'

describe('responses payload transformation', () => {
  it('normalizes model variants and removes unsupported input state', () => {
    expect(transformResponsesPayload({
      model: 'openai/gpt-5.6-sol-high',
      store: true,
      reasoning_effort: 'low',
      input: [
        { type: 'item_reference', id: 'private' },
        { type: 'message', id: 'server-id', content: 'hello' }
      ]
    })).toEqual({
      model: 'gpt-5.6-sol',
      store: false,
      reasoning: { effort: 'high', summary: 'auto' },
      input: [{ type: 'message', content: 'hello' }]
    })
  })
})

describe('runtime model injection', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL
    delete process.env.OPENCODE_MULTI_AUTH_INJECT_MODELS
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('injects GPT-5.5 and fast mode by default', async () => {
    const hooks = await MultiAuthPlugin({
      client: {},
      $: (() => ({ nothrow: () => ({ catch: () => undefined }) })) as any,
      serverUrl: new URL('http://localhost:3000'),
      project: { id: 'test' },
      directory: '/tmp'
    } as any)
    const config = {
      provider: {
        openai: {
          models: {},
          whitelist: []
        }
      }
    } as any

    await hooks.config?.(config)

    expect(config.provider.openai.models['gpt-5.5']).toEqual(
      expect.objectContaining({
        limit: { context: 530000, input: 400000, output: 130000 }
      })
    )
    expect(config.provider.openai.models['gpt-5.5-fast']).toBeDefined()
    expect(config.provider.openai.whitelist).toContain('gpt-5.5')
    expect(config.provider.openai.whitelist).toContain('gpt-5.5-fast')
  })
})

describe('broker auth loader', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('configures broker transport on a clean OpenCode install without OAuth credentials', async () => {
    const readablePath = path.resolve('package.json')
    process.env.OPENCODE_MULTI_AUTH_BROKER_ENABLED = 'true'
    process.env.OPENCODE_MULTI_AUTH_BROKER_URL = 'https://broker.example.test/v1/responses'
    process.env.OPENCODE_MULTI_AUTH_BROKER_CERT_PATH = readablePath
    process.env.OPENCODE_MULTI_AUTH_BROKER_KEY_PATH = readablePath
    process.env.OPENCODE_MULTI_AUTH_BROKER_CA_PATH = readablePath
    process.env.OPENCODE_MULTI_AUTH_BROKER_TIMEOUT_MS = '1000'
    process.env.OPENCODE_MULTI_AUTH_BROKER_MODELS = 'gpt-5.6-sol'
    const hooks = await MultiAuthPlugin({
      client: {},
      $: (() => ({ nothrow: () => ({ catch: () => undefined }) })) as any,
      serverUrl: new URL('http://localhost:3000'),
      project: { id: 'test' },
      directory: '/tmp'
    } as any)
    const config: any = {
      provider: {
        openai: {
          models: {
            'gpt-5.6-sol': { name: 'GPT-5.6 Support' }
          }
        }
      }
    }
    await hooks.config?.(config)

    expect(hooks.auth?.methods).toHaveLength(1)
    expect(hooks.auth?.methods[0]).toEqual(expect.objectContaining({
      type: 'api',
      label: 'Production broker (mTLS, no API token)',
      authorize: expect.any(Function)
    }))
    await expect((hooks.auth?.methods[0] as any).authorize()).resolves.toEqual({
      type: 'success',
      provider: 'openai',
      key: BROKER_TRANSPORT_API_KEY
    })
    expect(config.provider.openai.options).toEqual(expect.objectContaining({
      apiKey: BROKER_TRANSPORT_API_KEY,
      baseURL: 'https://broker.example.test/v1',
      fetch: expect.any(Function)
    }))
    await (hooks as any).dispose()
  })
})

describe('broker custom fetch', () => {
  it('reads a Request body and forwards only a transformed Responses POST', async () => {
    const controller = new AbortController()
    const request = jest.fn(async () => new Response('ok'))
    const brokerFetch = createBrokerFetch(
      { request } as any,
      DEFAULT_CONFIG.broker.models,
      'https://broker.example.test/v1/responses'
    )
    const input = new Request('https://broker.example.test/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer placeholder', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: 'openai/gpt-5.6-sol-high', store: true, background: true,
        previous_response_id: 'response_private'
      }),
      signal: controller.signal
    })

    const response = await brokerFetch(input)

    expect(await response.text()).toBe('ok')
    expect(request).toHaveBeenCalledWith({
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'high', summary: 'auto' }
    }, expect.objectContaining({
      headers: input.headers,
      signal: input.signal
    }))
  })

  it('rejects malformed JSON without calling the broker', async () => {
    const request = jest.fn(async () => new Response('unexpected'))
    const brokerFetch = createBrokerFetch(
      { request } as any,
      DEFAULT_CONFIG.broker.models,
      'https://broker.example.test/v1/responses'
    )
    const response = await brokerFetch(new Request('https://broker.example.test/v1/responses', {
      method: 'POST',
      body: '{malformed'
    }))

    expect(response.status).toBe(400)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects models outside the configured broker allowlist', async () => {
    const request = jest.fn(async () => new Response('unexpected'))
    const brokerFetch = createBrokerFetch(
      { request } as any,
      ['gpt-5.6-sol'],
      'https://broker.example.test/v1/responses'
    )
    const response = await brokerFetch('https://broker.example.test/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.6-unknown' })
    })

    expect(response.status).toBe(400)
    expect(request).not.toHaveBeenCalled()
  })

  it('preserves caller cancellation while reading the request body', async () => {
    const request = jest.fn(async () => new Response('unexpected'))
    const brokerFetch = createBrokerFetch(
      { request } as any,
      DEFAULT_CONFIG.broker.models,
      'https://broker.example.test/v1/responses'
    )
    const controller = new AbortController()
    controller.abort(new DOMException('caller cancelled', 'AbortError'))

    await expect(brokerFetch('https://broker.example.test/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.6-sol' }),
      signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError', message: 'caller cancelled' })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', 'https://broker.example.test/v1/responses', 405],
    ['POST', 'https://other.example.test/v1/responses', 404],
    ['POST', '/v1/responses', 404],
    ['POST', 'https://broker.example.test/responses', 404],
    ['POST', 'https://broker.example.test/v1/chat/completions', 404],
    ['POST', 'https://broker.example.test/v1/responses?unsafe=1', 404]
  ])('rejects %s %s', async (method, url, status) => {
    const request = jest.fn(async () => new Response('unexpected'))
    const brokerFetch = createBrokerFetch(
      { request } as any,
      DEFAULT_CONFIG.broker.models,
      'https://broker.example.test/v1/responses'
    )
    const response = await brokerFetch(url, {
      method,
      body: method === 'POST' ? '{}' : undefined
    })

    expect(response.status).toBe(status)
    expect(request).not.toHaveBeenCalled()
  })
})
