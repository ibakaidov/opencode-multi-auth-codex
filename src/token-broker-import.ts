import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { getStoreDiagnostics, loadStore, saveStore } from './store.js'
import type { AccountStore } from './types.js'

const MAX_IMPORT_BYTES = 2 * 1024 * 1024

export function importAccountStore(raw: string): number {
  if (!process.env.CODEX_SOFT_STORE_PASSPHRASE || !process.env.OPENCODE_MULTI_AUTH_STORE_DIR) {
    throw new Error('Encrypted store directory and passphrase are required')
  }
  const destination = getStoreDiagnostics().storeFile
  if (fs.existsSync(destination) || fs.existsSync(`${destination}.lkg`)) {
    throw new Error('Refusing to overwrite an existing OAuth store')
  }
  if (Buffer.byteLength(raw) > MAX_IMPORT_BYTES) throw new Error('Account store import exceeds size limit')
  const store = JSON.parse(raw) as AccountStore
  const entries = store?.accounts && typeof store.accounts === 'object' ? Object.entries(store.accounts) : []
  if (store?.version !== 2 || entries.length === 0 || entries.length > 100 ||
      entries.some(([alias, account]) => !alias || account?.alias !== alias || !account.accessToken ||
        !account.refreshToken || !Number.isFinite(account.expiresAt))) {
    throw new Error('Invalid account snapshot')
  }
  saveStore(store)
  const loaded = loadStore()
  const status = getStoreDiagnostics()
  if (status.locked || !status.encrypted || Object.keys(loaded.accounts).length !== entries.length) {
    throw new Error('Encrypted account import failed verification')
  }
  return entries.length
}

async function main(): Promise<void> {
  if (!process.env.TOKEN_BROKER_PASSPHRASE_FILE) throw new Error('Passphrase file is required')
  process.env.CODEX_SOFT_STORE_PASSPHRASE = fs.readFileSync(process.env.TOKEN_BROKER_PASSPHRASE_FILE, 'utf8').trim()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_IMPORT_BYTES) throw new Error('Account store import exceeds size limit')
    chunks.push(bytes)
  }
  const count = importAccountStore(Buffer.concat(chunks).toString('utf8'))
  console.log(`Imported ${count} accounts into encrypted server store`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Import failed')
    process.exitCode = 1
  })
}
