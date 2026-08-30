import { loadStore, getStoreStatus } from './store.js'
import type { LimitStatus, LimitsConfidence, RateLimitWindow } from './types.js'

export interface LimitsWindowSnapshot {
  limit?: number
  remaining?: number
  resetAt?: number
  updatedAt?: number
}

export interface AccountLimitsSnapshot {
  label: string
  active: boolean
  enabled: boolean
  status: LimitStatus
  confidence: LimitsConfidence
  fiveHour?: LimitsWindowSnapshot
  weekly?: LimitsWindowSnapshot
}

export interface LimitsSnapshot {
  locked: boolean
  accounts: AccountLimitsSnapshot[]
}

function copyWindow(window: RateLimitWindow | undefined): LimitsWindowSnapshot | undefined {
  if (!window) return undefined
  return {
    limit: window.limit,
    remaining: window.remaining,
    resetAt: window.resetAt,
    updatedAt: window.updatedAt
  }
}

export function getLimitsSnapshot(): LimitsSnapshot {
  const store = loadStore()
  return {
    locked: getStoreStatus().locked,
    accounts: Object.values(store.accounts).map((account, index) => ({
      label: `Account ${index + 1}`,
      active: account.alias === store.activeAlias,
      enabled: account.enabled !== false,
      status: account.limitStatus ?? 'idle',
      confidence: account.limitsConfidence ?? 'unknown',
      fiveHour: copyWindow(account.rateLimits?.fiveHour),
      weekly: copyWindow(account.rateLimits?.weekly)
    }))
  }
}
