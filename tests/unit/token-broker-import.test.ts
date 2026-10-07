import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importAccountStore } from '../../src/token-broker-import.js'
import { getStoreDiagnostics, loadStore } from '../../src/store.js'

describe('one-time encrypted account import', () => {
  const oldDir = process.env.OPENCODE_MULTI_AUTH_STORE_DIR
  const oldPassphrase = process.env.CODEX_SOFT_STORE_PASSPHRASE
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-import-'))
    process.env.OPENCODE_MULTI_AUTH_STORE_DIR = directory
    process.env.CODEX_SOFT_STORE_PASSPHRASE = 'test-only-secret'
  })

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true })
    if (oldDir === undefined) delete process.env.OPENCODE_MULTI_AUTH_STORE_DIR
    else process.env.OPENCODE_MULTI_AUTH_STORE_DIR = oldDir
    if (oldPassphrase === undefined) delete process.env.CODEX_SOFT_STORE_PASSPHRASE
    else process.env.CODEX_SOFT_STORE_PASSPHRASE = oldPassphrase
  })

  const snapshot = JSON.stringify({
    version: 2, activeAlias: 'one', rotationIndex: 0, lastRotation: 0,
    accounts: { one: {
      alias: 'one', accessToken: 'private-access', refreshToken: 'private-refresh',
      expiresAt: Date.now() + 60_000, usageCount: 0
    } }
  })

  it('encrypts every token and refuses to overwrite the owner store', () => {
    expect(importAccountStore(snapshot)).toBe(1)
    const diagnostics = getStoreDiagnostics()
    expect(diagnostics.encrypted).toBe(true)
    expect(diagnostics.locked).toBe(false)
    expect(fs.readFileSync(diagnostics.storeFile, 'utf8')).not.toMatch(/private-access|private-refresh/)
    expect(fs.existsSync(`${diagnostics.storeFile}.lkg`)).toBe(false)
    expect(loadStore().accounts.one.refreshToken).toBe('private-refresh')
    expect(() => importAccountStore(snapshot)).toThrow(/overwrite/)
  })

  it('rejects invalid snapshots without creating an account file', () => {
    expect(() => importAccountStore('{"version":2,"accounts":{"one":{}}}')).toThrow(/Invalid/)
    expect(fs.existsSync(getStoreDiagnostics().storeFile)).toBe(false)
  })
})
