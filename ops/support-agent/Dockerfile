FROM node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b AS plugin-build

WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts \
    && test "$(node -e 'import("./dist/support-agent.js").then((m) => process.stdout.write(Object.keys(m).join(",")))')" = "default"

FROM ghcr.io/anomalyco/opencode:1.18.23@sha256:182959d5ae507fa2b3dcfd6ec247ad625b7f15539977dd0620f43f7e24c78229

ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/ibakaidov/opencode-multi-auth-codex" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="opencode-1.18.23_plugin-1.4.4-broker.0"

RUN addgroup -g 10001 opencode \
    && adduser -D -H -u 10001 -G opencode opencode \
    && install -d -o opencode -g opencode /home/opencode /var/lib/opencode \
    && install -d -o root -g root -m 0555 /opt/opencode-config/opencode \
    && install -d -o root -g root -m 0555 /workspace \
    && test "$(opencode --version)" = "1.18.23"

COPY --chown=root:root ops/support-agent/runtime-package.json /opt/opencode-multi-auth-codex/package.json
COPY --from=plugin-build --chown=root:root /build/dist/support-agent.js /opt/opencode-multi-auth-codex/dist/support-agent.js
COPY --from=plugin-build --chown=root:root /build/dist/broker-client.js /opt/opencode-multi-auth-codex/dist/broker-client.js
COPY --from=plugin-build --chown=root:root /build/dist/broker-fetch.js /opt/opencode-multi-auth-codex/dist/broker-fetch.js
COPY --from=plugin-build --chown=root:root /build/dist/responses.js /opt/opencode-multi-auth-codex/dist/responses.js
COPY --from=plugin-build --chown=root:root /build/node_modules /opt/opencode-multi-auth-codex/node_modules
COPY --chown=root:root ops/support-agent/entrypoint.sh /usr/local/bin/support-agent-entrypoint
RUN chmod -R a-w /opt/opencode-multi-auth-codex \
    && chmod 0555 /usr/local/bin/support-agent-entrypoint

ENV HOME=/home/opencode \
    XDG_CONFIG_HOME=/opt/opencode-config \
    XDG_DATA_HOME=/var/lib/opencode/data \
    XDG_STATE_HOME=/var/lib/opencode/state \
    XDG_CACHE_HOME=/var/lib/opencode/cache \
    OPENCODE_CONFIG=/run/opencode/opencode.json \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true \
    OPENCODE_DISABLE_PROJECT_CONFIG=true \
    OPENCODE_MULTI_AUTH_BROKER_ENABLED=true \
    OPENCODE_MULTI_AUTH_BROKER_MODELS=gpt-5.6-sol

USER 10001:10001
WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/usr/local/bin/support-agent-entrypoint"]
