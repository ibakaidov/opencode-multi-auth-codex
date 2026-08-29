import fs from 'node:fs'
import path from 'node:path'
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'
import type { BrokerConfig } from './types.js'

const ENV_PREFIX = 'OPENCODE_MULTI_AUTH_BROKER_'
const MAX_TIMEOUT_MS = 5 * 60 * 1000
const MAX_ERROR_BODY_BYTES = 64 * 1024
const MAX_SSE_EVENT_BYTES = 256 * 1024
const MAX_RETRY_DELAY_MS = 30_000
const SAFE_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-type',
  'request-id',
  'retry-after',
  'x-request-id'
])
const SAFE_ERROR_FIELDS = new Set([
  'code',
  'detail',
  'error',
  'message',
  'requestId',
  'request_id',
  'retryAfter',
  'retry_after',
  'status',
  'type'
])

type BunRuntime = object
type BrokerFetchInit = RequestInit & {
  dispatcher?: Dispatcher
  tls?: {
    cert: unknown
    key: unknown
    ca: unknown[]
    rejectUnauthorized: boolean
  }
}
type BrokerFetch = (input: string | URL | Request, init?: BrokerFetchInit) => Promise<Response>

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after')?.trim()
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  return Math.min(1000 * (2 ** Math.min(attempt, 5)), MAX_RETRY_DELAY_MS)
}

function isRetryableBrokerStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

async function waitForRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) throw signal.reason
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface BrokerClient {
  models(): Promise<string[]>
  request(payload: Record<string, unknown>, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

export interface BrokerClientOptions {
  dispatcher?: Dispatcher
  fetchImpl?: BrokerFetch
  bun?: BunRuntime | null
}

function parseEnabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  if (value === '1' || value.toLowerCase() === 'true') return true
  if (value === '0' || value.toLowerCase() === 'false') return false
  throw new Error(`${ENV_PREFIX}ENABLED must be true, false, 1, or 0`)
}

function parseTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const timeout = Number(value)
  if (!Number.isInteger(timeout)) {
    throw new Error(`${ENV_PREFIX}TIMEOUT_MS must be an integer`)
  }
  return timeout
}

function parseModels(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === '') return [...fallback]
  return [...new Set(value.split(',').map(model => model.trim()).filter(Boolean))]
}

export function validateBrokerConfig(config: BrokerConfig): BrokerConfig {
  if (!config.enabled) return { ...config, models: [...config.models] }

  let url: URL
  try {
    url = new URL(config.url)
  } catch {
    throw new Error('Broker URL must be a valid absolute URL')
  }
  if (url.protocol !== 'https:') throw new Error('Broker URL must use HTTPS')
  if (url.username || url.password) throw new Error('Broker URL must not contain credentials')
  if (url.pathname !== '/v1/responses' || url.search || url.hash) {
    throw new Error('Broker URL must be exactly an HTTPS /v1/responses endpoint without query or fragment')
  }

  for (const [name, value] of [
    ['clientCertPath', config.clientCertPath],
    ['clientKeyPath', config.clientKeyPath],
    ['caPath', config.caPath]
  ] as const) {
    if (!value || !path.isAbsolute(value)) {
      throw new Error(`Broker ${name} must be an absolute path`)
    }
  }

  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Broker timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`)
  }
  if (config.models.length === 0 || config.models.some(model => !/^[a-zA-Z0-9._-]+$/.test(model))) {
    throw new Error('Broker models must contain at least one valid model ID')
  }

  return {
    ...config,
    url: url.toString(),
    models: [...new Set(config.models)]
  }
}

export function getBrokerConfig(base: BrokerConfig, env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const config: BrokerConfig = {
    enabled: parseEnabled(env[`${ENV_PREFIX}ENABLED`], base.enabled),
    url: env[`${ENV_PREFIX}URL`] ?? base.url,
    clientCertPath: env[`${ENV_PREFIX}CERT_PATH`] ?? base.clientCertPath,
    clientKeyPath: env[`${ENV_PREFIX}KEY_PATH`] ?? base.clientKeyPath,
    caPath: env[`${ENV_PREFIX}CA_PATH`] ?? base.caPath,
    timeoutMs: parseTimeout(env[`${ENV_PREFIX}TIMEOUT_MS`], base.timeoutMs),
    models: parseModels(env[`${ENV_PREFIX}MODELS`], base.models)
  }
  return validateBrokerConfig(config)
}

export function sanitizeBrokerRequestHeaders(input?: ConstructorParameters<typeof Headers>[0]): Headers {
  const source = new Headers(input)
  const headers = new Headers({
    accept: source.get('accept') || 'text/event-stream',
    'content-type': 'application/json'
  })
  return headers
}

function sanitizeResponseHeaders(input: Headers): Headers {
  const headers = new Headers()
  for (const [name, value] of input.entries()) {
    if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value)
  }
  return headers
}

function redactSensitiveText(value: string): string {
  const sensitiveLabel = [
    'access[_-]?token',
    'accessToken',
    'refresh[_-]?token',
    'refreshToken',
    'id[_-]?token',
    'idToken',
    'api[_-]?key',
    'apiKey',
    'account[ _-]?id',
    'accountId',
    'account[ _-]?alias',
    'accountAlias',
    'alias',
    'token'
  ].join('|')
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(
      new RegExp(`\\b(${sensitiveLabel})\\b(\\s*[:=]\\s*|\\s+)(?:"[^"]*"|'[^']*'|[^\\s,;}]+)`, 'gi'),
      '$1$2[redacted]'
    )
}

export function sanitizeBrokerError(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value) || !value || typeof value !== 'object') return undefined

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!SAFE_ERROR_FIELDS.has(key)) continue
    const sanitized = sanitizeBrokerError(child)
    if (sanitized !== undefined) result[key] = sanitized
  }
  return result
}

async function sanitizeErrorResponse(response: Response): Promise<Response> {
  const headers = sanitizeResponseHeaders(response.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        return new Response(JSON.stringify({
          error: {
            code: 'BROKER_ERROR_BODY_TOO_LARGE',
            message: 'Broker error response exceeded the size limit'
          }
        }), { status: response.status, headers })
      }
      chunks.push(value)
    }
  }

  const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
  try {
    const sanitized = sanitizeBrokerError(JSON.parse(text))
    if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized) || Object.keys(sanitized).length === 0) {
      throw new Error('empty sanitized error')
    }
    return new Response(JSON.stringify(sanitized), {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  } catch {
    return new Response(JSON.stringify({
      error: {
        code: 'BROKER_ERROR',
        message: 'Broker returned an invalid error response'
      }
    }), { status: response.status, statusText: response.statusText, headers })
  }
}

function fixedSseError(code: string, message: string): string {
  return `data: ${JSON.stringify({ type: 'error', error: { code, message } })}\n\n`
}

function sanitizeSseEvent(event: string): string {
  const declaredError = event
    .split(/\r?\n/)
    .some(line => line.trim().toLowerCase() === 'event: error')
  const data = event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return event

  try {
    const payload = JSON.parse(data) as Record<string, any>
    const type = typeof payload?.type === 'string' ? payload.type : ''
    if (!declaredError && type !== 'error' && !type.endsWith('.failed')) return event

    const error = sanitizeBrokerError(payload.error ?? payload.response?.error ?? payload)
    if (!error || typeof error !== 'object' || Array.isArray(error) || Object.keys(error).length === 0) {
      return fixedSseError('BROKER_STREAM_ERROR', 'Broker stream failed').trimEnd()
    }
    return `data: ${JSON.stringify({ type, error })}`
  } catch {
    return declaredError
      ? fixedSseError('BROKER_STREAM_ERROR', 'Broker stream failed').trimEnd()
      : event
  }
}

function createSanitizedSseStream(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
  callerSignal?: AbortSignal | null
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let cancelled = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const writeEvents = (atEnd = false): boolean => {
        while (true) {
          const match = /\r?\n\r?\n/.exec(buffer)
          if (!match) break
          const event = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          controller.enqueue(encoder.encode(`${sanitizeSseEvent(event)}\n\n`))
        }
        if (atEnd && buffer) {
          controller.enqueue(encoder.encode(sanitizeSseEvent(buffer)))
          buffer = ''
        }
        return Buffer.byteLength(buffer, 'utf8') <= MAX_SSE_EVENT_BYTES
      }

      try {
        while (!cancelled) {
          let timer: NodeJS.Timeout | undefined
          const idle = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new DOMException('Broker stream idle timeout', 'TimeoutError')), timeoutMs)
          })
          let result
          try {
            result = await Promise.race([reader.read(), idle])
          } finally {
            if (timer) clearTimeout(timer)
          }

          if (result.done) {
            buffer += decoder.decode()
            writeEvents(true)
            controller.close()
            return
          }
          buffer += decoder.decode(result.value, { stream: true })
          if (!writeEvents()) {
            await reader.cancel().catch(() => undefined)
            controller.enqueue(encoder.encode(fixedSseError(
              'BROKER_STREAM_EVENT_TOO_LARGE',
              'Broker stream event exceeded the size limit'
            )))
            controller.close()
            return
          }
        }
      } catch (error) {
        if (cancelled) return
        if (callerSignal?.aborted) {
          controller.error(callerSignal.reason)
          return
        }
        await reader.cancel().catch(() => undefined)
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
        controller.enqueue(encoder.encode(fixedSseError(
          timedOut ? 'BROKER_STREAM_TIMEOUT' : 'BROKER_STREAM_FAILED',
          timedOut ? 'Broker stream timed out while idle' : 'Broker stream failed'
        )))
        controller.close()
      }
    },
    async cancel(reason) {
      cancelled = true
      await reader.cancel(reason).catch(() => undefined)
    }
  })
}

function readCredential(pathname: string, label: string): Buffer {
  try {
    const stat = fs.statSync(pathname)
    if (!stat.isFile()) throw new Error('not a regular file')
    return fs.readFileSync(pathname)
  } catch {
    throw new Error(`Broker ${label} file is not readable`)
  }
}

export function createBrokerClient(config: BrokerConfig, options: BrokerClientOptions = {}): BrokerClient {
  const validated = validateBrokerConfig(config)
  if (!validated.enabled) throw new Error('Broker client cannot be created while broker mode is disabled')

  const bun = options.bun === undefined
    ? ((globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun || null)
    : options.bun
  const useBunTransport = bun !== null && !options.dispatcher && (!options.fetchImpl || options.bun !== undefined)
  const certificate = options.dispatcher ? null : readCredential(validated.clientCertPath, 'client certificate')
  const privateKey = options.dispatcher ? null : readCredential(validated.clientKeyPath, 'client key')
  const certificateAuthority = options.dispatcher ? null : readCredential(validated.caPath, 'CA certificate')
  const ownedDispatcher = options.dispatcher || useBunTransport
    ? null
    : new Agent({
      connect: {
        cert: certificate!,
        key: privateKey!,
        ca: certificateAuthority!,
        rejectUnauthorized: true
      }
    })
  const dispatcher = options.dispatcher || ownedDispatcher
  const fetchImpl = options.fetchImpl || (useBunTransport
    ? (globalThis.fetch as BrokerFetch)
    : (undiciFetch as unknown as BrokerFetch))
  const transport = useBunTransport
    ? {
        tls: {
          cert: certificate!,
          key: privateKey!,
          ca: [certificateAuthority!],
          rejectUnauthorized: true
        }
      }
    : { dispatcher: dispatcher! }

  return {
    async models() {
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => {
        timeoutController.abort(new DOMException('Broker headers timed out', 'TimeoutError'))
      }, validated.timeoutMs)
      try {
        const url = new URL('/v1/models', validated.url)
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          ...transport,
          signal: timeoutController.signal,
          redirect: 'error'
        })
        if (!response.ok) return []
        const payload = await response.json() as { data?: unknown }
        if (!Array.isArray(payload.data)) return []
        return [...new Set(payload.data.flatMap((model) => {
          if (!model || typeof model !== 'object') return []
          const id = (model as { id?: unknown }).id
          return typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id) ? [id] : []
        }))]
      } catch {
        return []
      } finally {
        clearTimeout(timeout)
      }
    },
    async request(payload, init = {}) {
      let attempt = 0
      while (true) {
        const timeoutController = new AbortController()
        const timeout = setTimeout(() => {
          timeoutController.abort(new DOMException('Broker headers timed out', 'TimeoutError'))
        }, validated.timeoutMs)
        const signal = init.signal
          ? AbortSignal.any([timeoutController.signal, init.signal])
          : timeoutController.signal
        try {
          const response = await fetchImpl(validated.url, {
            method: 'POST',
            headers: sanitizeBrokerRequestHeaders(init.headers),
            body: JSON.stringify(payload),
            ...transport,
            signal,
            redirect: 'error'
          })
          clearTimeout(timeout)
          if (isRetryableBrokerStatus(response.status)) {
            const delay = retryDelayMs(response, attempt++)
            await response.body?.cancel().catch(() => undefined)
            await waitForRetry(delay, init.signal)
            continue
          }
          if (!response.ok) return await sanitizeErrorResponse(response)
          const headers = sanitizeResponseHeaders(response.headers)
          if (!headers.has('content-type')) {
            headers.set('content-type', 'text/event-stream; charset=utf-8')
          }
          const body = response.body && headers.get('content-type')?.includes('text/event-stream')
            ? createSanitizedSseStream(response.body, validated.timeoutMs, init.signal)
            : response.body
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers
          })
        } catch (error) {
          if (init.signal?.aborted) throw error
          await waitForRetry(retryDelayMs(null, attempt++), init.signal)
        } finally {
          clearTimeout(timeout)
        }
      }
    },
    async close() {
      if (ownedDispatcher) await ownedDispatcher.close()
    }
  }
}
