import https from 'node:https';
import { getNextAccount } from './rotation.js';
import { DEFAULT_CONFIG } from './types.js';
function accountIdFromToken(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        const id = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
        return typeof id === 'string' && id.length > 0 ? id : null;
    }
    catch {
        return null;
    }
}
async function defaultLease(model, excludeAliases) {
    const result = await getNextAccount(DEFAULT_CONFIG, { model, excludeAliases });
    if (!result)
        return null;
    const accountId = accountIdFromToken(result.token);
    if (!accountId || result.account.expiresAt <= Date.now() + 30_000)
        return null;
    return {
        alias: result.account.alias,
        accessToken: result.token,
        accountId,
        expiresAt: result.account.expiresAt
    };
}
// One HTTPS process owns the refresh-token store. Never start a second broker on the same store.
export function createTokenBroker(options) {
    let pending = Promise.resolve();
    const lease = options.lease ?? defaultLease;
    return https.createServer({
        cert: options.cert,
        key: options.key,
        ca: options.ca,
        requestCert: true,
        rejectUnauthorized: true
    }, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST' || req.url !== '/v1/token') {
            res.writeHead(404).end();
            return;
        }
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 2048)
                req.destroy();
        });
        req.on('end', () => {
            let model;
            let excluded;
            try {
                const parsed = JSON.parse(body);
                if (typeof parsed.model !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(parsed.model) ||
                    !Array.isArray(parsed.excludeAliases) || parsed.excludeAliases.length > 32 ||
                    parsed.excludeAliases.some((alias) => typeof alias !== 'string' || alias.length > 128)) {
                    throw new Error('invalid request');
                }
                model = parsed.model;
                excluded = parsed.excludeAliases;
            }
            catch {
                res.writeHead(400).end();
                return;
            }
            const task = pending.then(() => lease(model, new Set(excluded)));
            pending = task.then(() => undefined, () => undefined);
            void task.then(result => {
                if (res.destroyed)
                    return;
                if (!result) {
                    res.writeHead(503).end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
            }, () => {
                if (!res.destroyed)
                    res.writeHead(503).end();
            });
        });
    });
}
export async function listenTokenBroker(server, port, host = '127.0.0.1') {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
    return server.address().port;
}
//# sourceMappingURL=token-broker.js.map