import { execFileSync } from 'node:child_process'
import { jest } from '@jest/globals'
import fs from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import type { TLSSocket } from 'node:tls'
import { createBrokerClient } from '../../src/broker-client.js'
import type { BrokerConfig } from '../../src/types.js'

jest.setTimeout(20_000)

interface TestPki {
  directory: string
  ca: string
  clientCert: string
  clientKey: string
  serverCert: string
  serverKey: string
}

function openssl(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'ignore' })
}

function createTestPki(): TestPki {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-mtls-'))
  const file = (name: string) => path.join(directory, name)

  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', file('ca.key'), '-out', file('ca.crt'),
    '-subj', '/CN=Broker Test CA', '-days', '1', '-sha256'
  ])
  openssl([
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', file('server.key'), '-out', file('server.csr'),
    '-subj', '/CN=127.0.0.1'
  ])
  fs.writeFileSync(file('server.ext'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
  openssl([
    'x509', '-req', '-in', file('server.csr'),
    '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial',
    '-out', file('server.crt'), '-days', '1', '-sha256', '-extfile', file('server.ext')
  ])
  openssl([
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', file('client.key'), '-out', file('client.csr'),
    '-subj', '/CN=Broker Test Client'
  ])
  fs.writeFileSync(file('client.ext'), 'extendedKeyUsage=clientAuth\n')
  openssl([
    'x509', '-req', '-in', file('client.csr'),
    '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial',
    '-out', file('client.crt'), '-days', '1', '-sha256', '-extfile', file('client.ext')
  ])

  return {
    directory,
    ca: file('ca.crt'),
    clientCert: file('client.crt'),
    clientKey: file('client.key'),
    serverCert: file('server.crt'),
    serverKey: file('server.key')
  }
}

function readJsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

describe('broker mTLS transport', () => {
  const pki = createTestPki()
  let server: https.Server
  let endpoint = ''
  let peerAuthorized = false
  let receivedHeaders: IncomingHttpHeaders = {}

  beforeAll(async () => {
    server = https.createServer({
      key: fs.readFileSync(pki.serverKey),
      cert: fs.readFileSync(pki.serverCert),
      ca: fs.readFileSync(pki.ca),
      requestCert: true,
      rejectUnauthorized: true
    }, async (request, response) => {
      peerAuthorized = (request.socket as TLSSocket).authorized
      receivedHeaders = request.headers
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }

      const payload = await readJsonRequest(request)
      if (payload.model === 'headers-timeout') return
      if (payload.model === 'redirect') {
        response.writeHead(302, { location: 'https://127.0.0.1/forbidden' }).end()
        return
      }

      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      if (payload.model === 'caller-abort') {
        response.write('data: first\n\n')
        return
      }

      setTimeout(() => response.write('data: com'), 60)
      setTimeout(() => response.end('plete\n\n'), 120)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')
    endpoint = `https://127.0.0.1:${address.port}/v1/responses`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(pki.directory, { recursive: true, force: true })
  })

  function config(timeoutMs: number): BrokerConfig {
    return {
      enabled: true,
      url: endpoint,
      clientCertPath: pki.clientCert,
      clientKeyPath: pki.clientKey,
      caPath: pki.ca,
      timeoutMs,
      models: ['gpt-5.6-sol']
    }
  }

  it('authenticates with a client certificate and does not abort a slow stream', async () => {
    const client = createBrokerClient(config(100))
    const response = await client.request({ model: 'gpt-5.6-sol' }, {
      headers: {
        Authorization: 'Bearer must-not-pass',
        'x-api-key': 'must-not-pass',
        'chatgpt-account-id': 'must-not-pass',
        Cookie: 'must-not-pass'
      }
    })

    expect(await response.text()).toBe('data: complete\n\n')
    expect(peerAuthorized).toBe(true)
    expect(receivedHeaders.authorization).toBeUndefined()
    expect(receivedHeaders['x-api-key']).toBeUndefined()
    expect(receivedHeaders['chatgpt-account-id']).toBeUndefined()
    expect(receivedHeaders.cookie).toBeUndefined()
    await client.close()
    const controller = new AbortController()
    const pending = client.request({ model: 'gpt-5.6-sol' }, { signal: controller.signal })
    controller.abort(new DOMException('caller cancelled', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps a header timeout pending until caller cancellation', async () => {
    const client = createBrokerClient(config(30))
    const controller = new AbortController()
    const pending = client.request({ model: 'headers-timeout' }, { signal: controller.signal })
    setTimeout(() => controller.abort(new DOMException('caller cancelled', 'AbortError')), 80)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await client.close()
  })

  it('keeps caller cancellation attached after headers', async () => {
    const client = createBrokerClient(config(1000))
    const controller = new AbortController()
    const response = await client.request({ model: 'caller-abort' }, { signal: controller.signal })
    controller.abort(new DOMException('caller cancelled', 'AbortError'))

    await expect(response.text()).rejects.toMatchObject({ name: 'AbortError' })
    await client.close()
  })

  it('does not follow broker redirects and remains pending until cancellation', async () => {
    const client = createBrokerClient(config(1000))
    const controller = new AbortController()
    const pending = client.request({ model: 'redirect' }, { signal: controller.signal })
    setTimeout(() => controller.abort(new DOMException('caller cancelled', 'AbortError')), 50)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await client.close()
  })
})
