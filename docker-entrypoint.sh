#!/usr/bin/env bash
set -euo pipefail

# Optional settings (unset keeps the Railway behaviour):
#   SYNARA_WRITER_LOCK      a file on the data volume, e.g. /data/.writer.lock. The server runs
#                           under an exclusive flock on it for its whole life, so a second
#                           controller sharing the volume (another host, a new revision) waits
#                           until this one has exited. Exports SYNARA_WRITER_LOCK_HELD=1 to the
#                           server once the lock is held.
#   SYNARA_USERDATA_CHOWN   always (default): chown -R /data/userdata to node on every start.
#                           auto: only when /data/userdata itself is not owned by node.
#                           off: never.

log() {
  printf '[entrypoint] %s\n' "$*" >&2
}

if [ "$(id -u)" -eq 0 ]; then
  # Read the owner before install -d, which would make the top directory node's either way.
  userdata_owner="$(stat -c %U /data/userdata 2>/dev/null || echo missing)"
  install -d -m 0700 -o node -g node /data/userdata
  case "${SYNARA_USERDATA_CHOWN:-always}" in
    always)
      chown -R --no-dereference node:node /data/userdata
      ;;
    auto)
      if [ "$userdata_owner" != node ]; then
        chown -R --no-dereference node:node /data/userdata
      fi
      ;;
    off) ;;
    *)
      log "SYNARA_USERDATA_CHOWN must be always, auto or off"
      exit 64
      ;;
  esac
  if [ -n "${SYNARA_WRITER_LOCK:-}" ]; then
    # The node user opens the lock file below. Create it only if it is missing (O_EXCL through
    # noclobber): replacing an existing lock file would give waiters and holder different inodes.
    install -d "$(dirname "$SYNARA_WRITER_LOCK")"
    for path in "$SYNARA_WRITER_LOCK" "$SYNARA_WRITER_LOCK.holder"; do
      (set -o noclobber; : >"$path") 2>/dev/null || true
      chown --no-dereference node:node "$path"
      chmod 0600 "$path"
    done
  fi
  exec /usr/sbin/runuser -u node -- "$0" "$@"
fi

if [ -n "${SYNARA_WRITER_LOCK:-}" ]; then
  # fd 9 stays open in this shell and is inherited by socat and the server, so the lock lives
  # exactly as long as this container's controller does. On NFS the server holds the lock and
  # drops it when this client closes the file or its lease expires.
  exec 9>>"$SYNARA_WRITER_LOCK"
  if ! flock -x -n 9; then
    log "waiting for the writer lock $SYNARA_WRITER_LOCK (held by: $(cat "$SYNARA_WRITER_LOCK.holder" 2>/dev/null || echo unknown))"
    flock -x 9
  fi
  printf 'host=%s pid=%s since=%s revision=%s\n' "$(hostname)" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${CONTAINER_APP_REVISION:-${RAILWAY_DEPLOYMENT_ID:-}}" >"$SYNARA_WRITER_LOCK.holder" 2>/dev/null || true
  log "holding the writer lock $SYNARA_WRITER_LOCK"
  export SYNARA_WRITER_LOCK_HELD=1
else
  # Only this script may claim the lock; never trust an inherited value.
  unset SYNARA_WRITER_LOCK_HELD
fi

# Dual-stack listener where IPv6 exists (Railway's private network is IPv6), IPv4 otherwise.
if node -e 'require("node:net").createServer().once("error", () => process.exit(1)).listen({ host: "::", port: 0, ipv6Only: false }, () => process.exit(0))' 2>/dev/null; then
  proxy_listen="TCP6-LISTEN:3773,fork,reuseaddr,ipv6only=0"
else
  log "IPv6 is unavailable; listening on IPv4 only"
  proxy_listen="TCP4-LISTEN:3773,fork,reuseaddr"
fi

socat "$proxy_listen" TCP:127.0.0.1:3774 &
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
