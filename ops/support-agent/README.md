# Support agent image

CI builds the plugin from this repository and copies it into the official OpenCode `1.18.23` linux/amd64 image pinned by manifest digest. The published tag is `ghcr.io/ibakaidov/opencode-multi-auth-codex-support-agent:sha-<40-character commit SHA>`; no moving tag is published and CI refuses to overwrite an existing SHA tag.

The broker-only plugin is loaded through OpenCode's documented local `file://` config mechanism. Its production dependency is already in `/opt/opencode-multi-auth-codex`, and the global OpenCode config directory is immutable, so startup cannot perform a Bun/npm install. Transport is installed by the plugin's `config` hook, with no auth hook, `auth.json`, OAuth store, plugin CLI, or account mutation modules in the runtime layer.

Mount `opencode.json`, the mTLS client certificate, private key, and CA certificate read-only at the paths below. Supply the broker URL and server password as runtime secrets/environment; do not bake them into an image or deployment manifest.

```sh
docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --tmpfs /var/lib/opencode:rw,noexec,nosuid,size=64m,uid=10001,gid=10001 \
  --mount type=bind,src=/etc/support-agent/opencode.json,dst=/run/opencode/opencode.json,readonly \
  --mount type=bind,src=/etc/support-agent/client.crt,dst=/run/secrets/broker-client.crt,readonly \
  --mount type=bind,src=/etc/support-agent/client.key,dst=/run/secrets/broker-client.key,readonly \
  --mount type=bind,src=/etc/support-agent/ca.crt,dst=/run/secrets/broker-ca.crt,readonly \
  --env OPENCODE_SERVER_PASSWORD \
  --env OPENCODE_MULTI_AUTH_BROKER_URL=https://broker.example/v1/responses \
  --env OPENCODE_MULTI_AUTH_BROKER_MODELS=gpt-5.6-sol \
  --publish 127.0.0.1:4096:4096 \
  ghcr.io/ibakaidov/opencode-multi-auth-codex-support-agent:sha-<commit-sha>
```

Do not mount a source repository. `/workspace` is an empty root-owned directory and the runtime user is UID/GID `10001`. OpenCode data, state, package cache, and logs are ephemeral under the `/var/lib/opencode` tmpfs. The supplied config disables all model tool permissions with `permission.* = deny`, disables sharing, snapshots, formatters, LSP, MCP, default plugins, project config discovery, downloads, and auto-update. The entrypoint refuses to start without a server password, broker URL, config, and all three mTLS files.

The CI smoke starts the exact locally tagged image with the production hardening flags, verifies `/global/health`, verifies that OpenAI exposes exactly `gpt-5.6-sol`, confirms that no OpenAI auth method is exposed on a clean data directory, checks the deny-all permission contract and absence of CLI/OAuth plugin modules, and only then pushes that same image ID to GHCR.
