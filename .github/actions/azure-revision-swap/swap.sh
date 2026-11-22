#!/usr/bin/env bash
# Stop-then-start revision swap for a container app whose server must never run twice at once: the
# controller's data sits on an NFS share under an exclusive flock (docker-entrypoint.sh,
# SYNARA_WRITER_LOCK), and a second process waits on that lock instead of starting.
#
#   1. Traffic is pinned to the revisions serving now, and the app runs in multiple-revision mode.
#   2. The new revision is created at 0% traffic with the image, SYNARA_COMMIT and the prepared
#      settings in one update (one revision, one start). Its container starts and blocks on the lock.
#   3. The old revisions are deactivated. Their process exits and releases the lock; the new one
#      takes it, opens the databases and becomes healthy.
#   4. The new revision gets 100% of traffic, and the public URL must report the new commit.
#
# If the new container never starts, it is deactivated and the old revision keeps serving. If it
# starts but never becomes healthy after the old one stopped, the swap rolls back: new deactivated,
# old reactivated and given its traffic again.
#
# Env: RESOURCE_GROUP, CONTAINER_APP, IMAGE, COMMIT; optional ENV_FILE (KEY=value lines),
# REVISION_SUFFIX, START_TIMEOUT_SECONDS (600), READY_TIMEOUT_SECONDS (900).
set -euo pipefail

: "${RESOURCE_GROUP:?}" "${CONTAINER_APP:?}" "${IMAGE:?}" "${COMMIT:?}"
suffix=${REVISION_SUFFIX:-g${COMMIT:0:7}-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}}
start_timeout=${START_TIMEOUT_SECONDS:-600}
ready_timeout=${READY_TIMEOUT_SECONDS:-900}
api_version=2025-01-01

app=(--name "$CONTAINER_APP" --resource-group "$RESOURCE_GROUP")
new="$CONTAINER_APP--$suffix"

log() { printf '[swap] %s\n' "$*"; }

# ARM answers 409 while an earlier operation on the app is still running: retry until a deadline.
retry() {
  local seconds=$1
  shift
  local deadline=$((SECONDS + seconds))
  until "$@"; do
    if ((SECONDS >= deadline)); then return 1; fi
    sleep 10
  done
}

wait_app_settled() {
  local deadline=$((SECONDS + 600)) state
  while :; do
    state=$(az containerapp show "${app[@]}" --query properties.provisioningState --output tsv)
    case "$state" in
      Succeeded | Failed | Canceled) return 0 ;;
    esac
    if ((SECONDS >= deadline)); then
      log "the app is still $state"
      return 1
    fi
    sleep 5
  done
}

app_json=$(az containerapp show "${app[@]}" --output json)
app_id=$(jq -r .id <<<"$app_json")
has_ingress=$(jq -r '.properties.configuration.ingress != null' <<<"$app_json")

# Traffic is written whole (only the traffic list is patched, as `az containerapp ingress traffic
# set` does), so no stale entries for deactivated revisions accumulate.
set_traffic() {
  [[ "$has_ingress" == true ]] || return 0
  az rest --method patch --url "https://management.azure.com${app_id}?api-version=${api_version}" \
    --body "{\"properties\":{\"configuration\":{\"ingress\":{\"traffic\":$1}}}}" --output none
}

if [[ "$(jq -r '.properties.configuration.activeRevisionsMode | ascii_downcase' <<<"$app_json")" != multiple ]]; then
  log "switching $CONTAINER_APP to multiple-revision mode"
  az containerapp revision set-mode "${app[@]}" --mode multiple --output none
  wait_app_settled
  app_json=$(az containerapp show "${app[@]}" --output json)
fi

mapfile -t old < <(az containerapp revision list "${app[@]}" --query "[?properties.active].name" --output tsv)
log "active revisions: ${old[*]:-none}"

# The serving revisions by name, so the new revision does not take traffic as "latest" on creation.
pinned=$(jq -c '
  .properties as $p
  | [($p.configuration.ingress.traffic // [])[] | select((.weight // 0) > 0)
     | {revisionName: (if .latestRevision then $p.latestReadyRevisionName else .revisionName end), weight}]
  | if any(.[]; .revisionName == null or .revisionName == "") then []
    else group_by(.revisionName) | map({revisionName: .[0].revisionName, weight: (map(.weight) | add)}) end
' <<<"$app_json")
if [[ "$has_ingress" == true && "$pinned" != "[]" ]]; then
  log "pinning traffic to $pinned"
  retry 300 set_traffic "$pinned"
  wait_app_settled
fi

updates=()
if [[ -n "${ENV_FILE:-}" && -s "$ENV_FILE" ]]; then
  mapfile -t updates < <(grep -E '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE")
  log "settings for the new revision: $(printf '%s ' "${updates[@]%%=*}")"
fi

# One replica, always: a second one would only wait on the writer lock, and none would stop the
# controller's background work.
log "creating $new from $IMAGE"
az containerapp update "${app[@]}" --image "$IMAGE" --revision-suffix "$suffix" \
  --min-replicas 1 --max-replicas 1 \
  --set-env-vars "SYNARA_COMMIT=$COMMIT" "${updates[@]}" \
  --no-wait --output none

started() {
  az containerapp replica list "${app[@]}" --revision "$new" --output json 2>/dev/null |
    jq -e 'any(.[]?.properties.containers[]?; .runningState == "Running" or .started == true or .ready == true)' >/dev/null
}

log "waiting for $new to start (it then waits on the writer lock while the old revision runs)"
deadline=$((SECONDS + start_timeout))
until started; do
  if ((SECONDS >= deadline)); then
    echo "::error::$new did not start within ${start_timeout}s; deactivating it. ${old[*]:-Nothing} keeps serving."
    retry 300 az containerapp revision deactivate "${app[@]}" --revision "$new" --output none || true
    exit 1
  fi
  sleep 10
done

rollback() {
  echo "::error::$new did not become healthy within ${ready_timeout}s; rolling back to ${old[*]:-nothing}."
  retry 300 az containerapp revision deactivate "${app[@]}" --revision "$new" --output none || true
  for revision in "${old[@]}"; do
    retry 300 az containerapp revision activate "${app[@]}" --revision "$revision" --output none || true
  done
  if [[ "$pinned" != "[]" ]]; then retry 300 set_traffic "$pinned" || true; fi
  exit 1
}

for revision in "${old[@]}"; do
  [[ "$revision" == "$new" ]] && continue
  log "deactivating $revision"
  retry 600 az containerapp revision deactivate "${app[@]}" --revision "$revision" --output none || rollback
done

log "waiting for $new to take the writer lock and become healthy"
deadline=$((SECONDS + ready_timeout))
next_report=0
while :; do
  state=$(az containerapp revision show "${app[@]}" --revision "$new" \
    --query "{health: properties.healthState, provisioning: properties.provisioningState, running: properties.runningState}" --output json)
  health=$(jq -r '.health // ""' <<<"$state")
  provisioning=$(jq -r '.provisioning // ""' <<<"$state")
  [[ "$health" == Healthy ]] && break
  [[ "$provisioning" == Failed ]] && rollback
  ((SECONDS >= deadline)) && rollback
  if ((SECONDS >= next_report)); then
    log "$new: $(jq -c . <<<"$state")"
    next_report=$((SECONDS + 60))
  fi
  sleep 10
done

log "$new is healthy; sending it all traffic"
retry 300 set_traffic "[{\"revisionName\":\"$new\",\"weight\":100}]"
wait_app_settled || true

public_url=$(az containerapp show "${app[@]}" --output json |
  jq -r '[.properties.template.containers[0].env[]? | select(.name == "SYNARA_PUBLIC_URL") | .value // empty][0] // empty')
if [[ -n "$public_url" ]]; then
  deadline=$((SECONDS + 300))
  until [[ "$(curl -fsS --max-time 5 "${public_url%/}/api/version" 2>/dev/null | jq -r '.commit // empty' 2>/dev/null)" == "$COMMIT" ]]; do
    if ((SECONDS >= deadline)); then
      echo "::error::${public_url%/}/api/version does not report $COMMIT"
      exit 1
    fi
    sleep 5
  done
  log "${public_url%/} serves $COMMIT"
fi
log "done: $new"
