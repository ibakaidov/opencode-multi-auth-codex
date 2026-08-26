import path from 'node:path'
import SupportAgentPlugin from '../../src/support-agent.js'

describe('support-agent plugin', () => {
  const originalEnv = process.env

  beforeEach(() => {
    const readablePath = path.resolve('package.json')
    process.env = {
      ...originalEnv,
      OPENCODE_MULTI_AUTH_BROKER_ENABLED: 'true',
      OPENCODE_MULTI_AUTH_BROKER_URL: 'https://broker.example.test/v1/responses',
      OPENCODE_MULTI_AUTH_BROKER_CERT_PATH: readablePath,
      OPENCODE_MULTI_AUTH_BROKER_KEY_PATH: readablePath,
      OPENCODE_MULTI_AUTH_BROKER_CA_PATH: readablePath,
      OPENCODE_MULTI_AUTH_BROKER_MODELS: 'gpt-5.6-sol'
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('has no auth surface and enforces exactly one broker model', async () => {
    const hooks = await SupportAgentPlugin({} as any)
    const config: any = {
      provider: {
        openai: {
          models: {
            'gpt-5.6-sol': { name: 'GPT-5.6 Support' },
            fallback: { name: 'Hidden fallback' }
          },
          whitelist: ['gpt-5.6-sol', 'fallback']
        }
      }
    }

    await hooks.config?.(config)

    expect(hooks.auth).toBeUndefined()
    expect(Object.keys(config.provider.openai.models)).toEqual(['gpt-5.6-sol'])
    expect(config.provider.openai.whitelist).toEqual(['gpt-5.6-sol'])
    expect(config.provider.openai.options).toEqual(expect.objectContaining({
      apiKey: 'mTLS-client-certificate',
      baseURL: 'https://broker.example.test/v1',
      fetch: expect.any(Function)
    }))
    await (hooks as any).dispose?.()
  })
})
