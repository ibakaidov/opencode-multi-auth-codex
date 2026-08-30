import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addAccount, updateAccount } from '../../src/store.js'
import { getLimitsSnapshot } from '../../src/limits-snapshot.js'

describe('Limits snapshot', () => {
  const originalStoreDir = process.env.OPENCODE_MULTI_AUTH_STORE_DIR
  const storeDir = path.join(os.tmpdir(), `oma-limits-snapshot-${process.pid}`)

  beforeEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true })
    process.env.OPENCODE_MULTI_AUTH_STORE_DIR = storeDir
  })

  afterAll(() => {
    fs.rmSync(storeDir, { recursive: true, force: true })
    if (originalStoreDir === undefined) delete process.env.OPENCODE_MULTI_AUTH_STORE_DIR
    else process.env.OPENCODE_MULTI_AUTH_STORE_DIR = originalStoreDir
  })

  it('exposes limits without account credentials or identifiers', () => {
    addAccount('user@example.com', {
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accountId: 'account-id',
      expiresAt: Date.now() + 60_000,
      email: 'user@example.com',
      rateLimits: {
        fiveHour: { limit: 100, remaining: 75, resetAt: 123, updatedAt: 100 },
        weekly: { limit: 100, remaining: 50, resetAt: 456, updatedAt: 200 }
      }
    })
    updateAccount('user@example.com', {
      limitStatus: 'success',
      limitsConfidence: 'fresh',
      limitError: 'raw upstream error'
    })

    const snapshot = getLimitsSnapshot()
    expect(snapshot.accounts).toEqual([{
      label: 'Account 1',
      active: true,
      enabled: true,
      status: 'success',
      confidence: 'fresh',
      fiveHour: { limit: 100, remaining: 75, resetAt: 123, updatedAt: 100 },
      weekly: { limit: 100, remaining: 50, resetAt: 456, updatedAt: 200 }
    }])
    expect(JSON.stringify(snapshot)).not.toMatch(/access-secret|refresh-secret|user@example|account-id|raw upstream/)
  })
})
