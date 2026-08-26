import { type Dispatcher } from 'undici';
import type { BrokerConfig } from './types.js';
type BrokerFetchInit = RequestInit & {
    dispatcher?: Dispatcher;
};
type BrokerFetch = (input: string | URL | Request, init?: BrokerFetchInit) => Promise<Response>;
export interface BrokerClient {
    request(payload: Record<string, unknown>, init?: RequestInit): Promise<Response>;
    close(): Promise<void>;
}
export interface BrokerClientOptions {
    dispatcher?: Dispatcher;
    fetchImpl?: BrokerFetch;
}
export declare function validateBrokerConfig(config: BrokerConfig): BrokerConfig;
export declare function getBrokerConfig(base: BrokerConfig, env?: NodeJS.ProcessEnv): BrokerConfig;
export declare function sanitizeBrokerRequestHeaders(input?: ConstructorParameters<typeof Headers>[0]): Headers;
export declare function sanitizeBrokerError(value: unknown): unknown;
export declare function createBrokerClient(config: BrokerConfig, options?: BrokerClientOptions): BrokerClient;
export {};
//# sourceMappingURL=broker-client.d.ts.map