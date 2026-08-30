import type { LimitStatus, LimitsConfidence } from './types.js';
export interface LimitsWindowSnapshot {
    limit?: number;
    remaining?: number;
    resetAt?: number;
    updatedAt?: number;
}
export interface AccountLimitsSnapshot {
    label: string;
    active: boolean;
    enabled: boolean;
    status: LimitStatus;
    confidence: LimitsConfidence;
    fiveHour?: LimitsWindowSnapshot;
    weekly?: LimitsWindowSnapshot;
}
export interface LimitsSnapshot {
    locked: boolean;
    accounts: AccountLimitsSnapshot[];
}
export declare function getLimitsSnapshot(): LimitsSnapshot;
//# sourceMappingURL=limits-snapshot.d.ts.map