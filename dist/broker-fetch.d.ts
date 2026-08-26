import type { BrokerClient } from './broker-client.js';
export declare const BROKER_TRANSPORT_API_KEY = "mTLS-client-certificate";
export declare function createBrokerFetch(client: Pick<BrokerClient, 'request'>, allowedModels: readonly string[], endpoint: string, strictModels?: boolean): typeof fetch;
export declare function getBrokerSdkBaseUrl(endpoint: string): string;
//# sourceMappingURL=broker-fetch.d.ts.map