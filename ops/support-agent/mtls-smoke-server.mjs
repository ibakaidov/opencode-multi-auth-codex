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
  if (request.method === 'POST' && request.url === '/v1/responses' && request.socket.authorized) {
    fs.writeFileSync(markerPath, 'authorized\n', { mode: 0o600 })
  }
  request.resume()
  response.writeHead(400, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { code: 'SMOKE_COMPLETE', message: 'mTLS request received' } }))
})

server.listen(0, '0.0.0.0', () => {
  const address = server.address()
  fs.writeFileSync(portPath, String(address.port), { mode: 0o600 })
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
