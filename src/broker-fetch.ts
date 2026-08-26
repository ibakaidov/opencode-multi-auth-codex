import type { BrokerClient } from './broker-client.js'
import { transformResponsesPayload } from './responses.js'

export const BROKER_TRANSPORT_API_KEY = 'mTLS-client-certificate'

function extractRequestUrl(input: Request | string | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

async function readBrokerRequestBody(
  input: Request | string | URL,
  init?: RequestInit,
  signal?: AbortSignal | null
): Promise<Record<string, any> | null> {
  try {
    if (signal?.aborted) throw signal.reason
    let textPromise: Promise<string>
    if (init?.body !== undefined && init.body !== null) {
      textPromise = new Response(init.body).text()
    } else if (input instanceof Request) {
      textPromise = input.clone().text()
    } else {
      return null
    }

    const text = signal
      ? await new Promise<string>((resolve, reject) => {
        const onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        textPromise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
      })
      : await textPromise
    if (!text.trim()) return null
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  }
}

function brokerRequestError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

function isResponsesEndpoint(input: Request | string | URL, endpoint: string): boolean {
  try {
    const url = new URL(extractRequestUrl(input))
    const expected = new URL(endpoint)
    return (
      url.origin === expected.origin &&
      url.pathname === '/v1/responses' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

export function createBrokerFetch(
  client: Pick<BrokerClient, 'request'>,
  allowedModels: readonly string[],
  endpoint: string,
  strictModels = false
): typeof fetch {
  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null
    const method = (init?.method || request?.method || 'GET').toUpperCase()
    if (method !== 'POST') {
      return brokerRequestError(405, 'BROKER_METHOD_NOT_ALLOWED', 'Broker mode only accepts Responses POST requests')
    }
    if (!isResponsesEndpoint(input, endpoint)) {
      return brokerRequestError(404, 'BROKER_ENDPOINT_NOT_FOUND', 'Broker mode only accepts the Responses endpoint')
    }

    const signal = init?.signal ?? request?.signal
    const body = await readBrokerRequestBody(input, init, signal)
    if (!body) {
      return brokerRequestError(400, 'INVALID_RESPONSES_PAYLOAD', 'Responses request body must be a JSON object')
    }

    if (strictModels && (typeof body.model !== 'string' || !allowedModels.includes(body.model))) {
      return brokerRequestError(400, 'BROKER_MODEL_NOT_ALLOWED', 'Responses model is not in the broker allowlist')
    }
    const payload = transformResponsesPayload(body)
    delete payload.background
    delete payload.store
    delete payload.previous_response_id
    if (typeof payload.model !== 'string' || !allowedModels.includes(payload.model)) {
      return brokerRequestError(400, 'BROKER_MODEL_NOT_ALLOWED', 'Responses model is not in the broker allowlist')
    }

    return client.request(payload, {
      headers: init?.headers || request?.headers,
      signal
    })
  }
}

export function getBrokerSdkBaseUrl(endpoint: string): string {
  const url = new URL(endpoint)
  url.pathname = '/v1'
  return url.toString().replace(/\/$/, '')
}
