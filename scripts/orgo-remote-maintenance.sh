#!/bin/bash
set -Eeuo pipefail

export HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
STATE_DIR="$HERMES_HOME/maintenance"
BACKUP_DIR="/root/orgo-ai-guy-bot-backups/daily"
LOCK_FILE="$STATE_DIR/maintenance.lock"
LOG_FILE="$STATE_DIR/maintenance.log"
ROTATED_LOG="$STATE_DIR/maintenance.log.1"
LOG_MAX_BYTES=5242880
RECEIPT_FILE="$STATE_DIR/last-run.json"
RUNTIME_CHECKOUT="${HERMES_RUNTIME_CHECKOUT:-/usr/local/lib/hermes-agent}"

mkdir -p "$STATE_DIR" "$BACKUP_DIR"
chmod 700 "$STATE_DIR" "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf '%s maintenance already running\n' "$(date -u +%FT%TZ)" >>"$LOG_FILE"
  exit 0
fi

if [[ -f "$LOG_FILE" ]] && [[ "$(wc -c <"$LOG_FILE")" -gt "$LOG_MAX_BYTES" ]]; then
  mv -f "$LOG_FILE" "$ROTATED_LOG"
  chmod 600 "$ROTATED_LOG"
fi

started_at="$(date -u +%FT%TZ)"
before_version="$(hermes --version 2>/dev/null || true)"
status="running"
backup_path=""
update_check=""
pre_update_sha=""
update_started=0

write_receipt() {
  STATUS="$status" STARTED_AT="$started_at" BEFORE_VERSION="$before_version" \
  AFTER_VERSION="$(hermes --version 2>/dev/null || true)" BACKUP_PATH="$backup_path" \
  UPDATE_CHECK="$update_check" PRE_UPDATE_SHA="$pre_update_sha" \
  RECEIPT_FILE="$RECEIPT_FILE" python3 -c '
import json
import os
from pathlib import Path
payload = {
    "product": "Orgo AI Guy Bot",
    "status": os.environ["STATUS"],
    "started_at": os.environ["STARTED_AT"],
    "finished_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
    "before_version": os.environ["BEFORE_VERSION"],
    "after_version": os.environ["AFTER_VERSION"],
    "backup_path": os.environ["BACKUP_PATH"],
    "pre_update_sha": os.environ["PRE_UPDATE_SHA"],
    "update_check": os.environ["UPDATE_CHECK"][:2000],
}
target = Path(os.environ["RECEIPT_FILE"])
temporary = target.with_suffix(".tmp")
temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
temporary.chmod(0o600)
temporary.replace(target)
'
}

supervisor_program_configured() {
  local program="$1"
  local status_output
  status_output="$(supervisorctl status "$program" 2>&1 || true)"
  [[ "$status_output" == "$program "* ]]
}

restart_gateway() {
  if command -v supervisorctl >/dev/null 2>&1 && supervisor_program_configured speakeragent-gateway; then
    supervisorctl restart speakeragent-gateway
  elif command -v supervisorctl >/dev/null 2>&1 && supervisor_program_configured hermes-gateway; then
    supervisorctl restart hermes-gateway
  else
    hermes gateway restart
  fi
}

stop_gateway() {
  if command -v supervisorctl >/dev/null 2>&1 && supervisorctl status speakeragent-gateway >/dev/null 2>&1; then
    supervisorctl stop speakeragent-gateway
  elif command -v supervisorctl >/dev/null 2>&1 && supervisorctl status hermes-gateway >/dev/null 2>&1; then
    supervisorctl stop hermes-gateway
  else
    hermes gateway stop
  fi
}

verify_services() {
  hermes gateway status
  hermes mcp test orgo-agent
  hermes mcp test orgo
  hermes mcp test super-browser
}

checkout_is_clean() {
  [[ -z "$(git -C "$RUNTIME_CHECKOUT" status --porcelain --untracked-files=all)" ]]
}

rollback_update() {
  status="rollback-failed"
  printf '%s update or health check failed; starting code and data rollback\n' \
    "$(date -u +%FT%TZ)"

  [[ "$pre_update_sha" =~ ^[0-9a-f]{40}$ ]] || {
    printf '%s rollback refused: invalid pre-update SHA\n' "$(date -u +%FT%TZ)"
    return 1
  }
  git -C "$RUNTIME_CHECKOUT" cat-file -e "$pre_update_sha^{commit}" || return 1
  stop_gateway || return 1
  git -C "$RUNTIME_CHECKOUT" reset --hard "$pre_update_sha" || return 1
  (
    cd "$RUNTIME_CHECKOUT"
    uvx --from "uv==0.9.28" uv sync --locked --python 3.11 --extra all --extra dev
  ) || return 1
  hermes import --force "$backup_path" || return 1
  restart_gateway || return 1
  verify_services || return 1

  status="rolled-back"
  printf '%s rollback completed and verified at %s\n' \
    "$(date -u +%FT%TZ)" "$pre_update_sha"
}

on_error() {
  failed_rc=$?
  trap - ERR
  if [[ "$update_started" == 1 ]]; then
    if ! rollback_update >>"$LOG_FILE" 2>&1; then
      status="rollback-failed"
      printf '%s rollback failed; manual recovery required\n' \
        "$(date -u +%FT%TZ)" >>"$LOG_FILE"
      restart_gateway >>"$LOG_FILE" 2>&1 || true
    fi
  else
    status="failed"
    restart_gateway >>"$LOG_FILE" 2>&1 || true
  fi
  write_receipt || true
  return "$failed_rc"
}
trap on_error ERR

{
  printf '%s starting Orgo AI Guy Bot maintenance\n' "$started_at"

  git -C "$RUNTIME_CHECKOUT" rev-parse --is-inside-work-tree | grep -qx true
  if ! checkout_is_clean; then
    printf '%s maintenance refused: runtime checkout is dirty\n' \
      "$(date -u +%FT%TZ)"
    false
  fi
  pre_update_sha="$(git -C "$RUNTIME_CHECKOUT" rev-parse HEAD)"
  [[ "$pre_update_sha" =~ ^[0-9a-f]{40}$ ]]

  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_path="$BACKUP_DIR/hermes-daily-$stamp.zip"
  hermes backup --output "$backup_path"
  chmod 600 "$backup_path"
  /usr/bin/find "$BACKUP_DIR" -type f -name 'hermes-daily-*.zip' -mtime +14 -delete

  update_check="$(hermes update --check 2>&1)"
  printf '%s\n' "$update_check"
  update_args=(--yes --backup)
  if hermes update --help 2>&1 | grep -q -- '--keep-stash'; then
    update_args+=(--keep-stash)
  fi
  update_started=1
  hermes update "${update_args[@]}"

  if ! hermes gateway status; then
    restart_gateway
  fi
  verify_services
  hermes curator run

  update_started=0
  status="healthy"
  write_receipt
  printf '%s maintenance completed successfully\n' "$(date -u +%FT%TZ)"
} >>"$LOG_FILE" 2>&1

trap - ERR
