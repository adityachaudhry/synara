#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  install -d -m 0700 -o node -g node /data/userdata
  install -d -m 0750 -o node -g node /data/worktrees /data/gitea-company-projects
  exec /usr/sbin/runuser -u node -- "$0" "$@"
fi

socat TCP6-LISTEN:3773,fork,reuseaddr,ipv6only=0 TCP:127.0.0.1:3774 &
proxy_pid=$!

node /app/apps/server/dist/index.mjs &
server_pid=$!

shutdown() {
  kill -TERM "$proxy_pid" "$server_pid" 2>/dev/null || true
}

trap shutdown INT TERM

set +e
wait -n "$proxy_pid" "$server_pid"
exit_code=$?
set -e

shutdown
wait "$proxy_pid" "$server_pid" 2>/dev/null || true
exit "$exit_code"
