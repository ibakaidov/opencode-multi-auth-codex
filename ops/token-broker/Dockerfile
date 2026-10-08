FROM node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b AS runtime
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
RUN addgroup -g 10001 broker && adduser -D -H -u 10001 -G broker broker
WORKDIR /app
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/package.json ./package.json
USER 10001:10001
EXPOSE 4545
ENTRYPOINT ["node", "/app/dist/token-broker-main.js"]

FROM runtime AS broker
COPY --chown=root:root ops/token-broker/opencode.json /app/opencode.json

FROM runtime AS support-agent
USER 0:0
COPY --from=runtime --chown=root:root /app/dist /opt/opencode-multi-auth-codex/dist
COPY --from=runtime --chown=root:root /app/node_modules /opt/opencode-multi-auth-codex/node_modules
COPY --chown=root:root ops/support-agent/opencode.json /etc/support-agent/opencode.json
COPY --chown=root:root ops/support-agent/entrypoint.sh /usr/local/bin/support-agent-entrypoint
ENV HOME=/var/lib/opencode/home \
    XDG_CONFIG_HOME=/var/lib/opencode/config \
    XDG_DATA_HOME=/var/lib/opencode/data \
    XDG_STATE_HOME=/var/lib/opencode/state \
    XDG_CACHE_HOME=/var/lib/opencode/cache \
    OPENCODE_CONFIG=/etc/support-agent/opencode.json \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true \
    OPENCODE_DISABLE_PROJECT_CONFIG=true
RUN install -d -o broker -g broker /var/lib/opencode /var/lib/opencode/home
USER 10001:10001
WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/usr/local/bin/support-agent-entrypoint"]
