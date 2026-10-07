# Support agent image

CI builds the plugin from this repository and copies it into the official OpenCode `1.18.23` linux/amd64 image pinned by manifest digest. The published tag is `ghcr.io/ibakaidov/opencode-multi-auth-codex-support-agent:sha-<40-character commit SHA>`; no moving tag is published and CI refuses to overwrite an existing SHA tag.

The token-client plugin is loaded through OpenCode's documented local `file://` config mechanism. It gets a short-lived access token from a separate mTLS token broker; inference requests go directly from this container to the provider. No auth hook, `auth.json`, OAuth store, plugin CLI, or refresh token is present in the runtime layer.

The OpenCode config is pinned inside the CI image. Mount the mTLS client certificate, private key, and CA certificate read-only. Supply the broker URL and server password as runtime secrets/environment; do not bake them into an image or deployment manifest.

```sh
docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
  --network support-private \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --mount type=volume,src=opencode-support-data,dst=/var/lib/opencode \
  --mount type=bind,src=/etc/support-agent/client.crt,dst=/run/secrets/broker-client.crt,readonly \
  --mount type=bind,src=/etc/support-agent/client.key,dst=/run/secrets/broker-client.key,readonly \
  --mount type=bind,src=/etc/support-agent/ca.crt,dst=/run/secrets/broker-ca.crt,readonly \
  --env OPENCODE_SERVER_PASSWORD \
  --env OPENCODE_MULTI_AUTH_TOKEN_BROKER_URL=https://token-broker:4545/v1/token \
  --publish 127.0.0.1:4096:4096 \
  ghcr.io/ibakaidov/opencode-multi-auth-codex-support-agent:sha-<commit-sha>
```

Do not mount a source repository. `/workspace` is an empty root-owned directory and the runtime user is UID/GID `10001`. The dedicated `/var/lib/opencode` volume must be owned by UID 10001, backed up securely, and retained across image upgrades to preserve the one support session ID. The supplied config disables all model tool permissions with `permission.* = deny`, disables sharing, snapshots, formatters, LSP, MCP, default plugins, project config discovery, downloads, and auto-update. The entrypoint refuses to start without a server password, broker URL, config, and all three mTLS files. The sample assumes an isolated private Docker network where `token-broker` resolves; expose its port only on host loopback for the SSH tunnel to Mac.

The CI smoke starts the exact locally tagged image with production hardening flags, verifies `/global/health`, verifies that OpenAI exposes exactly `gpt-5.6-sol`, confirms that no OpenAI auth method is exposed, checks the deny-all permission contract, and confirms that a model attempt requests only a token from the test broker. CI uses tmpfs rather than the persistent production volume; no provider inference succeeds with the fake smoke token.
