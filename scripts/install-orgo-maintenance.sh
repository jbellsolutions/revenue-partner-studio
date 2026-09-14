#!/bin/bash
set -euo pipefail

LABEL="com.orgo.ai-guy-bot.maintenance"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$HOME/Library/Application Support/Hermes Bots/maintenance"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PYTHON_BIN="/usr/bin/python3"
if (($#)); then
  APP_PATH="$1"
else
  APP_PATH="/Applications/Orgo AI Guy Bot.app"
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' "This scheduler installer is for macOS only." >&2
  exit 2
fi
if [[ ! -f "$REPO_ROOT/scripts/orgo_maintenance.py" ]]; then
  printf '%s\n' "Maintenance controller is missing from $REPO_ROOT" >&2
  exit 2
fi
if [[ ! -d "$APP_PATH" ]]; then
  printf '%s\n' "Installed app is missing from $APP_PATH" >&2
  exit 2
fi

mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE_DIR"

export APP_PATH LABEL REPO_ROOT STATE_DIR PLIST PYTHON_BIN
"$PYTHON_BIN" -c '
import os
import plistlib
from pathlib import Path

label = os.environ["LABEL"]
repo = Path(os.environ["REPO_ROOT"])
state = Path(os.environ["STATE_DIR"])
config = {
    "Label": label,
    "ProgramArguments": [
        os.environ["PYTHON_BIN"],
        str(repo / "scripts/orgo_maintenance.py"),
        "--apply",
        "--repo",
        str(repo),
        "--state-dir",
        str(state),
        "--app",
        os.environ["APP_PATH"],
    ],
    "EnvironmentVariables": {
        "GIT_TERMINAL_PROMPT": "0",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
    "RunAtLoad": True,
    "StartCalendarInterval": {"Hour": 4, "Minute": 35},
    "ProcessType": "Background",
    "LowPriorityIO": True,
    "StandardOutPath": str(state / "launch-agent.stdout.log"),
    "StandardErrorPath": str(state / "launch-agent.stderr.log"),
}
path = Path(os.environ["PLIST"])
with path.open("wb") as handle:
    plistlib.dump(config, handle, sort_keys=True)
path.chmod(0o600)
'

/usr/bin/plutil -lint "$PLIST" >/dev/null
DOMAIN="gui/$UID"
/bin/launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
/bin/launchctl bootstrap "$DOMAIN" "$PLIST"
/bin/launchctl enable "$DOMAIN/$LABEL"
/bin/launchctl kickstart -k "$DOMAIN/$LABEL"

printf '%s\n' "Installed daily Orgo AI Guy Bot maintenance: $PLIST"
