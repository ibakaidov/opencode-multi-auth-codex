import { loadStore, getStoreStatus } from './store.js';
function copyWindow(window) {
    if (!window)
        return undefined;
    return {
        limit: window.limit,
        remaining: window.remaining,
        resetAt: window.resetAt,
        updatedAt: window.updatedAt
    };
}
export function getLimitsSnapshot() {
    const store = loadStore();
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
    };
}
//# sourceMappingURL=limits-snapshot.js.map