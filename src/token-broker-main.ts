import fs from 'node:fs'
import { createTokenBroker, listenTokenBroker } from './token-broker.js'
import { getStoreDiagnostics, listAccounts } from './store.js'

async function main(): Promise<void> {
  if (process.env.TOKEN_BROKER_PASSPHRASE_FILE) {
    process.env.CODEX_SOFT_STORE_PASSPHRASE = fs.readFileSync(process.env.TOKEN_BROKER_PASSPHRASE_FILE, 'utf8').trim()
  }
  const cert = process.env.TOKEN_BROKER_CERT_PATH
  const key = process.env.TOKEN_BROKER_KEY_PATH
  const ca = process.env.TOKEN_BROKER_CA_PATH
  const port = Number(process.env.TOKEN_BROKER_PORT || '4545')
  const host = process.env.TOKEN_BROKER_BIND || '127.0.0.1'
  if (!cert || !key || !ca || !process.env.CODEX_SOFT_STORE_PASSPHRASE ||
      !Number.isInteger(port) || port < 1 || port > 65535 || !['127.0.0.1', '0.0.0.0'].includes(host)) {
    throw new Error('Encrypted store, mTLS paths, and valid port are required')
  }
  const accounts = listAccounts()
  const status = getStoreDiagnostics()
  if (status.locked || !status.encrypted || accounts.length === 0) {
    throw new Error('Refusing to serve without an unlocked encrypted account store')
  }
  const server = createTokenBroker({
    cert: fs.readFileSync(cert), key: fs.readFileSync(key), ca: fs.readFileSync(ca)
  })
  await listenTokenBroker(server, port, host)
  process.on('SIGTERM', () => server.close())
  console.log(`Token broker ready on ${host}:${port}`)
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Token broker failed')
  process.exitCode = 1
})
