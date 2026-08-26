import fs from 'node:fs'
import https from 'node:https'

const [certificatePath, keyPath, caPath, portPath, markerPath] = process.argv.slice(2)
const server = https.createServer({
  cert: fs.readFileSync(certificatePath),
  key: fs.readFileSync(keyPath),
  ca: fs.readFileSync(caPath),
  requestCert: true,
  rejectUnauthorized: true
}, (request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    let payload
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      payload = null
    }
    if (
      request.method === 'POST' &&
      request.url === '/v1/responses' &&
      request.socket.authorized &&
      payload?.model === 'gpt-5.6-sol' &&
      !Object.hasOwn(payload, 'store') &&
      !Object.hasOwn(payload, 'background') &&
      !Object.hasOwn(payload, 'previous_response_id')
    ) {
      fs.writeFileSync(markerPath, 'authorized\n', { mode: 0o600 })
    }
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'SMOKE_COMPLETE', message: 'mTLS request received' } }))
  })
})

server.listen(0, '0.0.0.0', () => {
  const address = server.address()
  fs.writeFileSync(portPath, String(address.port), { mode: 0o600 })
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
