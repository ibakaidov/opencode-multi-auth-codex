#!/bin/sh
set -eu

image=$1
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
container=opencode-support-agent-smoke
response=$(mktemp -d)

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker logs "$container" >&2 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$response"
  return "$status"
}
trap cleanup EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$response/client.key" \
  -out "$response/client.crt" \
  -subj /CN=smoke-client \
  -days 1 >/dev/null 2>&1
cp "$response/client.crt" "$response/ca.crt"
chmod 0444 "$response/client.key" "$response/client.crt" "$response/ca.crt"

docker run --detach --name "$container" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --tmpfs /var/lib/opencode:rw,noexec,nosuid,size=64m,uid=10001,gid=10001 \
  --mount "type=bind,src=$root/ops/support-agent/opencode.json,dst=/run/opencode/opencode.json,readonly" \
  --mount "type=bind,src=$response/client.crt,dst=/run/secrets/broker-client.crt,readonly" \
  --mount "type=bind,src=$response/client.key,dst=/run/secrets/broker-client.key,readonly" \
  --mount "type=bind,src=$response/ca.crt,dst=/run/secrets/broker-ca.crt,readonly" \
  --env OPENCODE_SERVER_PASSWORD=smoke \
  --env OPENCODE_MULTI_AUTH_BROKER_URL=https://broker.invalid/v1/responses \
  --env OPENCODE_MULTI_AUTH_BROKER_MODELS=gpt-5.6-sol \
  --publish 127.0.0.1::4096 \
  "$image" >/dev/null

port=$(docker port "$container" 4096/tcp | sed 's/.*://')
ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl --fail --silent --show-error --max-time 5 --user opencode:smoke \
    "http://127.0.0.1:$port/global/health" >"$response/health.json"; then
    ready=true
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
    docker logs "$container"
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done
test "$ready" = true

jq -e '.healthy == true and .version == "1.18.23"' "$response/health.json" >/dev/null
providers_status=$(curl --silent --show-error --user opencode:smoke \
  --max-time 30 --output "$response/providers.json" --write-out '%{http_code}' \
  "http://127.0.0.1:$port/config/providers?directory=%2Fworkspace")
if [ "$providers_status" != 200 ]; then
  echo "OpenCode providers endpoint returned $providers_status:" >&2
  cat "$response/providers.json" >&2
  exit 1
fi
jq -e '[.providers[] | select(.id == "openai")][0] as $p | ($p.models | keys) == ["gpt-5.6-sol"] and $p.models["gpt-5.6-sol"].id == "gpt-5.6-sol"' \
  "$response/providers.json" >/dev/null
curl --fail --silent --show-error --user opencode:smoke \
  --max-time 30 \
  "http://127.0.0.1:$port/provider/auth?directory=%2Fworkspace" >"$response/auth.json"
jq -e '.openai == null' \
  "$response/auth.json" >/dev/null
curl --fail --silent --show-error --user opencode:smoke \
  --max-time 30 \
  "http://127.0.0.1:$port/config?directory=%2Fworkspace" >"$response/config.json"
jq -e '.permission["*"] == "deny" and .snapshot == false and .share == "disabled"' \
  "$response/config.json" >/dev/null
test "$(docker inspect --format '{{.Config.User}}' "$container")" = "10001:10001"
docker inspect "$container" | jq -e \
  '.[0].HostConfig.ReadonlyRootfs == true and .[0].HostConfig.CapDrop == ["ALL"] and (.[0].HostConfig.SecurityOpt | index("no-new-privileges")) != null' \
  >/dev/null
docker exec "$container" test ! -e /var/lib/opencode/data/opencode/auth.json
docker exec "$container" test ! -e /opt/opencode-config/opencode/node_modules
docker exec "$container" test ! -e /opt/opencode-multi-auth-codex/dist/cli.js
docker exec "$container" test ! -e /opt/opencode-multi-auth-codex/dist/auth.js
