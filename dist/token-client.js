import fs from 'node:fs';
import { Agent, fetch as secureFetch } from 'undici';
import { transformResponsesPayload } from './responses.js';
const backend = 'https://chatgpt.com/backend-api/codex/responses';
const authClaim = 'https://api.openai.com/auth';
// This mode must not import auth.ts, store.ts, or auth-sync.ts: Mac never reads refresh tokens.
const TokenClientPlugin = async () => {
    const endpoint = process.env.OPENCODE_MULTI_AUTH_TOKEN_BROKER_URL;
    if (!endpoint)
        throw new Error('Token broker URL is required');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.pathname !== '/v1/token' ||
        url.search || url.hash || url.username || url.password) {
        throw new Error('Token broker must be HTTPS on loopback at /v1/token');
    }
    const certPath = process.env.OPENCODE_MULTI_AUTH_TOKEN_BROKER_CERT_PATH;
    const keyPath = process.env.OPENCODE_MULTI_AUTH_TOKEN_BROKER_KEY_PATH;
    const caPath = process.env.OPENCODE_MULTI_AUTH_TOKEN_BROKER_CA_PATH;
    const isBun = Boolean(globalThis.Bun);
    const cert = certPath ? fs.readFileSync(certPath) : undefined;
    const key = keyPath ? fs.readFileSync(keyPath) : undefined;
    const ca = caPath ? fs.readFileSync(caPath) : undefined;
    if (!isBun && (!cert || !key || !ca))
        throw new Error('Token broker mTLS paths are required');
    const dispatcher = isBun ? null : new Agent({ connect: { cert, key, ca, rejectUnauthorized: true } });
    async function lease(model, excludeAliases, signal) {
        const request = {
            method: 'POST', signal: signal || undefined, redirect: 'manual',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, excludeAliases: [...excludeAliases] })
        };
        const response = isBun
            ? await globalThis.fetch(url, {
                ...request, tls: { cert: cert, key: key, ca: [ca], rejectUnauthorized: true }
            })
            : await secureFetch(url, { ...request, dispatcher: dispatcher });
        if (response.status !== 200)
            throw new Error(`Token broker unavailable (${response.status})`);
        const value = await response.json();
        if (typeof value.accessToken !== 'string' || !value.accessToken ||
            typeof value.alias !== 'string' || !value.alias ||
            typeof value.accountId !== 'string' || !value.accountId ||
            typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now() + 30_000) {
            throw new Error('Invalid token broker response');
        }
        let claims = null;
        try {
            claims = JSON.parse(Buffer.from(value.accessToken.split('.')[1], 'base64url').toString('utf8'));
        }
        catch {
            throw new Error('Invalid token broker response');
        }
        if (claims?.[authClaim]?.chatgpt_account_id !== value.accountId)
            throw new Error('Token account mismatch');
        return value;
    }
    return {
        dispose: async () => { await dispatcher?.close(); },
        config: async (config) => {
            const provider = config.provider?.openai;
            if (!provider || !provider.models)
                throw new Error('OpenAI provider models are required');
            provider.options = {
                apiKey: 'remote-token-broker',
                baseURL: 'https://chatgpt.com/backend-api',
                timeout: false,
                headerTimeout: false,
                bodyTimeout: 0,
                fetch: async (input, init) => {
                    const request = input instanceof Request ? input : null;
                    const original = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString());
                    if (original.origin !== 'https://chatgpt.com' || original.pathname !== '/backend-api/responses' ||
                        original.search || original.hash || (init?.method || request?.method || 'POST').toUpperCase() !== 'POST') {
                        return new Response(null, { status: 404 });
                    }
                    const body = JSON.parse(String(init?.body || await request?.clone().text() || '{}'));
                    if (typeof body.model !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(body.model)) {
                        return new Response(null, { status: 400 });
                    }
                    const excluded = new Set();
                    const payload = transformResponsesPayload(body);
                    payload.store = false;
                    delete payload.background;
                    delete payload.previous_response_id;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        let account;
                        try {
                            account = await lease(body.model, excluded, init?.signal || request?.signal);
                        }
                        catch (error) {
                            if (error instanceof Error && error.message === 'Invalid token broker response')
                                return new Response(null, { status: 502 });
                            return new Response(null, { status: 503 });
                        }
                        const headers = new Headers({
                            'content-type': 'application/json', 'accept': 'text/event-stream',
                            'authorization': `Bearer ${account.accessToken}`,
                            'chatgpt-account-id': account.accountId,
                            'OpenAI-Beta': 'responses=experimental', 'originator': 'codex_cli_rs'
                        });
                        if (typeof body.prompt_cache_key === 'string') {
                            headers.set('conversation_id', body.prompt_cache_key);
                            headers.set('session_id', body.prompt_cache_key);
                        }
                        let response;
                        try {
                            response = await fetch(backend, {
                                method: 'POST', headers, signal: init?.signal || request?.signal,
                                body: JSON.stringify(payload)
                            });
                        }
                        catch {
                            return new Response(null, { status: 502 });
                        }
                        if (response.status !== 401 && response.status !== 403 && response.status !== 429)
                            return response;
                        excluded.add(account.alias);
                        if (attempt === 2)
                            return response;
                    }
                    return new Response(null, { status: 503 });
                }
            };
        }
    };
};
export default TokenClientPlugin;
//# sourceMappingURL=token-client.js.map