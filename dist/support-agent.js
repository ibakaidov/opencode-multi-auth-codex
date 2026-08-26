import { createBrokerClient, getBrokerConfig } from './broker-client.js';
import { BROKER_TRANSPORT_API_KEY, createBrokerFetch, getBrokerSdkBaseUrl } from './broker-fetch.js';
const PROVIDER_ID = 'openai';
const MODEL_ID = 'gpt-5.6-sol';
const SupportAgentPlugin = async () => {
    const config = getBrokerConfig({
        enabled: false,
        url: '',
        clientCertPath: '',
        clientKeyPath: '',
        caPath: '',
        timeoutMs: 30_000,
        models: [MODEL_ID]
    });
    if (!config.enabled || config.models.length !== 1 || config.models[0] !== MODEL_ID) {
        throw new Error('[support-agent] Broker mode must expose only gpt-5.6-sol');
    }
    const client = createBrokerClient(config);
    return {
        dispose: async () => {
            await client.close();
        },
        config: async (runtimeConfig) => {
            const provider = runtimeConfig.provider?.[PROVIDER_ID];
            const model = provider?.models?.[MODEL_ID];
            if (!provider || typeof provider !== 'object' || !model) {
                throw new Error('[support-agent] OpenAI gpt-5.6-sol provider config is required');
            }
            provider.models = { [MODEL_ID]: model };
            provider.whitelist = [MODEL_ID];
            provider.options = {
                apiKey: BROKER_TRANSPORT_API_KEY,
                baseURL: getBrokerSdkBaseUrl(config.url),
                fetch: createBrokerFetch(client, config.models, config.url, true)
            };
        }
    };
};
export default SupportAgentPlugin;
//# sourceMappingURL=support-agent.js.map