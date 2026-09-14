#!/usr/bin/env bash
set -euo pipefail

PRODUCT="Orgo AI Guy Bot"
REPO_URL="https://github.com/jbellsolutions/orgo-ai-guy-bot.git"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECKOUT="${ORGO_AI_GUY_BOT_HOME:-$HOME/Orgo-AI-Guy-Bot}"
SYSTEM_APP="/Applications/Orgo AI Guy Bot.app"
if [[ -n "${ORGO_AI_GUY_BOT_APPLICATIONS_DIR:-}" ]]; then
  INSTALL_ROOT="$ORGO_AI_GUY_BOT_APPLICATIONS_DIR"
elif [[ -d "$SYSTEM_APP" || -w /Applications ]]; then
  INSTALL_ROOT="/Applications"
else
  INSTALL_ROOT="$HOME/Applications"
fi
DEST="$INSTALL_ROOT/Orgo AI Guy Bot.app"
LAUNCHER_DIR="$HOME/.local/bin"
LAUNCHER_DEST="$LAUNCHER_DIR/orgo-ai-guy-bot"
MODE="install"
ASSUME_YES=false

usage() {
  printf '%s\n' \
    "Install Orgo AI Guy Bot from its authenticated source repository." \
    "" \
    "Usage: ./install.sh [--check|--dry-run] [--yes]" \
    "  --check    Inspect prerequisites without changing anything." \
    "  --dry-run  Print the exact installation plan without changing anything." \
    "  --yes      Confirm the plan non-interactively after an AI or human explained it."
}

discover_source_app() {
  local release_root="$1"
  local candidates=()
  local candidate
  for candidate in "$release_root"/mac*/"$PRODUCT.app"; do
    [[ -d "$candidate" ]] && candidates+=("$candidate")
  done
  if ((${#candidates[@]} != 1)); then
    printf 'Build must produce exactly one app artifact under %s/mac*/%s.app; found %d.\n' \
      "$release_root" "$PRODUCT" "${#candidates[@]}" >&2
    return 8
  fi
  printf '%s\n' "${candidates[0]}"
}

stop_installed_app() {
  local executable="$DEST/Contents/MacOS/$PRODUCT"
  local process_pattern="^$executable( --orgo-instance=[a-z0-9_-]+)?$"
  local attempt
  local quit_pid

  [[ -d "$DEST" ]] || return 0
  /usr/bin/pgrep -f "$process_pattern" >/dev/null 2>&1 || return 0
  /usr/bin/osascript -e 'tell application id "com.nousresearch.hermes-bots" to quit' >/dev/null 2>&1 &
  quit_pid=$!

  for attempt in {1..10}; do
    if ! /usr/bin/pgrep -f "$process_pattern" >/dev/null 2>&1; then
      wait "$quit_pid" 2>/dev/null || true
      return 0
    fi
    # LaunchServices addresses one process at a time for a shared bundle ID.
    # Once that quit finishes, request a graceful quit from the next instance.
    if ! kill -0 "$quit_pid" >/dev/null 2>&1; then
      wait "$quit_pid" 2>/dev/null || true
      /usr/bin/osascript -e 'tell application id "com.nousresearch.hermes-bots" to quit' >/dev/null 2>&1 &
      quit_pid=$!
    fi
    sleep 1
  done

  kill "$quit_pid" >/dev/null 2>&1 || true
  wait "$quit_pid" 2>/dev/null || true
  printf '%s did not stop cleanly; the existing app was left untouched.\n' "$PRODUCT" >&2
  return 1
}

installed_app_is_healthy() {
  local executable="$DEST/Contents/MacOS/$PRODUCT"
  local attempt
  local before_log_state='missing'
  local after_log_state='missing'
  local desktop_log="${HERMES_HOME:-$HOME/.hermes-korgo}/logs/desktop.log"
  local started=false

  if [[ -f "$desktop_log" ]]; then
    before_log_state="$(stat -f '%m:%z' "$desktop_log" 2>/dev/null || printf 'missing')"
  fi
  /usr/bin/open -na "$DEST" || return 1

  for attempt in {1..10}; do
    if /usr/bin/pgrep -f "^$executable$" >/dev/null 2>&1; then
      started=true
      break
    fi
    sleep 1
  done

  [[ "$started" == true ]] || return 1
  sleep 5
  /usr/bin/pgrep -f "^$executable$" >/dev/null 2>&1 || return 1
  after_log_state="$(stat -f '%m:%z' "$desktop_log" 2>/dev/null || printf 'missing')"
  [[ "$after_log_state" != "$before_log_state" ]]
}

while (($#)); do
  case "$1" in
    --check) MODE="check" ;;
    --dry-run) MODE="dry-run" ;;
    --yes) ASSUME_YES=true ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s currently supports macOS only.\n' "$PRODUCT" >&2
  exit 1
fi

missing=()
for command_name in git node npm uv uvx; do
  command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
done
if command -v node >/dev/null 2>&1; then
  node_version="$(node -p 'process.versions.node')"
  node_major="${node_version%%.*}"
  node_minor="$(printf '%s' "$node_version" | cut -d. -f2)"
  if ((node_major < 22 || (node_major == 22 && node_minor < 22))); then
    missing+=("Node.js 22.22+ (found v$node_version)")
  fi
fi

if ((${#missing[@]})); then
  printf 'Missing prerequisites:\n' >&2
  printf '  - %s\n' "${missing[@]}" >&2
  printf 'An AI installer should explain and install only these prerequisites from official sources, then rerun --check.\n' >&2
  exit 3
fi

# When install.sh is launched from a real clone of this repository, build that
# checkout directly. This avoids cloning the same source a second time and is
# the normal fast path for a downloaded or agent-provided installer folder.
if [[ -z "${ORGO_AI_GUY_BOT_HOME:-}" && -d "$SCRIPT_REPO/.git" ]]; then
  script_repo_url="$(git -C "$SCRIPT_REPO" remote get-url origin 2>/dev/null || true)"
  case "$script_repo_url" in
    "$REPO_URL"|"${REPO_URL%.git}") CHECKOUT="$SCRIPT_REPO" ;;
  esac
fi

printf 'Preflight passed: macOS, Git, Node.js, npm, uv, and uvx are ready.\n'
if [[ "$MODE" == "check" ]]; then
  exit 0
fi

printf '%s\n' \
  "Installation plan:" \
  "  1. Clone or safely fast-forward $REPO_URL at $CHECKOUT." \
  "  2. Install locked project dependencies and run source verification." \
  "  3. Build the native Orgo AI Guy Bot.app locally." \
  "  4. Back up any existing app, install to $DEST, ad-hoc sign the local build, and open it." \
  "  5. Install the multi-instance launcher at $LAUNCHER_DEST." \
  "  6. Leave credentials and cloud provisioning to each instance's guided first run." \
  "Preserved: ~/.hermes and ~/Library/Application Support/Hermes Bots."

if [[ "$MODE" == "dry-run" ]]; then
  exit 0
fi

if [[ "$ASSUME_YES" != true ]]; then
  if [[ ! -t 0 ]]; then
    printf 'Interactive confirmation is unavailable. Rerun with --yes only after the plan has been explained and approved.\n' >&2
    exit 4
  fi
  read -r -p "Continue with this plan? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { printf 'Installation cancelled.\n'; exit 0; }
fi

if [[ -d "$CHECKOUT/.git" ]]; then
  current_url="$(git -C "$CHECKOUT" remote get-url origin)"
  case "$current_url" in
    "$REPO_URL"|"${REPO_URL%.git}") ;;
    *) printf 'Existing checkout has a different origin: %s\n' "$current_url" >&2; exit 5 ;;
  esac
  if [[ -n "$(git -C "$CHECKOUT" status --porcelain)" ]]; then
    printf 'Existing checkout has local changes. Refusing to overwrite them.\n' >&2
    exit 6
  fi
  git -C "$CHECKOUT" pull --ff-only
elif [[ -e "$CHECKOUT" ]]; then
  printf 'Install path exists but is not this repository: %s\n' "$CHECKOUT" >&2
  exit 7
else
  git clone "$REPO_URL" "$CHECKOUT"
fi

cd "$CHECKOUT"
./scripts/setup-hermes-bots.sh --verify
npm --workspace apps/desktop run pack:bot
SOURCE_APP="$(discover_source_app "$CHECKOUT/apps/desktop/release")"

mkdir -p "$INSTALL_ROOT"
backup=""
install_complete=false
restore_previous_app() {
  local status=$?
  trap - EXIT
  if [[ "$install_complete" != true && -n "$backup" && -e "$backup" ]]; then
    if [[ -e "$DEST" ]]; then
      failed="$INSTALL_ROOT/.Orgo AI Guy Bot.app.failed.$(date -u +%Y%m%dT%H%M%SZ)"
      if ! mv "$DEST" "$failed"; then
        printf 'Installation failed; could not quarantine the failed replacement. Previous app remains at %s\n' "$backup" >&2
        exit "$status"
      fi
    fi
    if mv "$backup" "$DEST"; then
      printf 'Installation failed; restored the previous app at %s\n' "$DEST" >&2
      /usr/bin/open -na "$DEST" >/dev/null 2>&1 || true
    else
      printf 'Installation failed and automatic restoration failed; previous app remains at %s\n' "$backup" >&2
    fi
  fi
  exit "$status"
}
trap restore_previous_app EXIT
if [[ -e "$DEST" ]]; then
  stop_installed_app
  backup="$INSTALL_ROOT/Orgo AI Guy Bot.app.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$DEST" "$backup"
  printf 'Previous app saved at %s\n' "$backup"
fi
/usr/bin/ditto "$SOURCE_APP" "$DEST"
/usr/bin/codesign --force --deep --sign - "$DEST"
mkdir -p "$LAUNCHER_DIR"
install -m 0755 "$CHECKOUT/scripts/orgo-ai-guy-bot" "$LAUNCHER_DEST"

name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$DEST/Contents/Info.plist")"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$DEST/Contents/Info.plist")"
[[ "$name" == "$PRODUCT" ]]
[[ "$bundle_id" == "com.nousresearch.hermes-bots" ]]
/bin/bash "$CHECKOUT/scripts/install-orgo-maintenance.sh" "$DEST"
printf 'Daily self-update installed for %s.\n' "$PRODUCT"
if ! installed_app_is_healthy; then
  printf '%s launched but did not stay running; restoring the previous app.\n' "$PRODUCT" >&2
  exit 10
fi
install_complete=true
trap - EXIT
printf '%s installed and opened successfully at %s\n' "$PRODUCT" "$DEST"
printf 'Launch another isolated Orgo machine with: %s INSTANCE\n' "$LAUNCHER_DEST"
