#!/bin/sh
set -eu

image=$1
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
container=opencode-support-agent-smoke
response=$(mktemp -d)
broker_pid=

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker logs "$container" >&2 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [ -n "$broker_pid" ]; then
    kill "$broker_pid" >/dev/null 2>&1 || true
    wait "$broker_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$response"
  return "$status"
}
trap cleanup EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$response/ca.key" \
  -out "$response/ca.crt" \
  -subj /CN=smoke-ca \
  -days 1 >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$response/client.key" -out "$response/client.csr" \
  -subj /CN=smoke-client >/dev/null 2>&1
openssl x509 -req -in "$response/client.csr" -CA "$response/ca.crt" -CAkey "$response/ca.key" \
  -CAcreateserial -out "$response/client.crt" -days 1 >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$response/server.key" -out "$response/server.csr" \
  -subj /CN=broker.test >/dev/null 2>&1
printf 'subjectAltName=DNS:broker.test\nextendedKeyUsage=serverAuth\n' >"$response/server.ext"
openssl x509 -req -in "$response/server.csr" -CA "$response/ca.crt" -CAkey "$response/ca.key" \
  -CAcreateserial -out "$response/server.crt" -days 1 -extfile "$response/server.ext" >/dev/null 2>&1
chmod 0444 "$response/client.key" "$response/client.crt" "$response/ca.crt"

node "$root/ops/support-agent/mtls-smoke-server.mjs" \
  "$response/server.crt" "$response/server.key" "$response/ca.crt" \
  "$response/broker.port" "$response/broker.hit" &
broker_pid=$!
attempt=0
while [ ! -s "$response/broker.port" ]; do
  if ! kill -0 "$broker_pid" >/dev/null 2>&1; then
    echo 'mTLS smoke server stopped before listening' >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'mTLS smoke server did not listen' >&2
    exit 1
  fi
  sleep 1
done
broker_port=$(cat "$response/broker.port")

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
  --add-host broker.test:host-gateway \
  --env OPENCODE_SERVER_PASSWORD=smoke \
  --env OPENCODE_MULTI_AUTH_BROKER_URL="https://broker.test:$broker_port/v1/responses" \
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
docker exec "$container" test ! -e /opt/opencode-multi-auth-codex/dist/cli.js
docker exec "$container" test ! -e /opt/opencode-multi-auth-codex/dist/auth.js

session_id=$(curl --fail --silent --show-error --user opencode:smoke \
  --header 'content-type: application/json' --data '{"title":"mTLS smoke"}' \
  "http://127.0.0.1:$port/session" | jq -er '.id')
curl --silent --show-error --user opencode:smoke --max-time 45 \
  --header 'content-type: application/json' \
  --data '{"messageID":"msg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","model":{"providerID":"openai","modelID":"gpt-5.6-sol"},"parts":[{"type":"text","text":"Return JSON only."}],"tools":{"bash":false,"edit":false,"write":false,"read":false,"glob":false,"grep":false,"webfetch":false,"task":false}}' \
  "http://127.0.0.1:$port/session/$session_id/message" >"$response/message.json" || true
attempt=0
while [ ! -s "$response/broker.hit" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'exact support image did not authenticate to the mTLS broker' >&2
    cat "$response/message.json" >&2 || true
    exit 1
  fi
  sleep 1
done
