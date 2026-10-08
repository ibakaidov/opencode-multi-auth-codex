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
