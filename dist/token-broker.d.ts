import https from 'node:https';
export type TokenLease = {
    alias: string;
    accessToken: string;
    accountId: string;
    expiresAt: number;
};
export type TokenBrokerOptions = {
    cert: string | Buffer;
    key: string | Buffer;
    ca: string | Buffer;
    lease?: (model: string, excludeAliases: Set<string>) => Promise<TokenLease | null>;
};
export declare function createTokenBroker(options: TokenBrokerOptions): https.Server;
export declare function listenTokenBroker(server: https.Server, port: number, host?: string): Promise<number>;
//# sourceMappingURL=token-broker.d.ts.map