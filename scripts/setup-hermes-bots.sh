#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UV_VERSION="0.9.28"
RUN_APP=false
VERIFY=false

usage() {
  cat <<'EOF'
Set up Orgo AI Guy Bot from a source checkout.

Usage:
  ./scripts/setup-hermes-bots.sh [--run] [--verify]

Options:
  --run       Launch the Bot product after setup.
  --verify    Run the desktop type-check before launching.
  -h, --help  Show this help.

Prerequisites:
  macOS, Git, Node.js 22.22+, npm, and uv.
EOF
}

while (($# > 0)); do
  case "$1" in
    --run)
      RUN_APP=true
      ;;
    --verify)
      VERIFY=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Orgo AI Guy Bot currently supports source use on macOS." >&2
  exit 1
fi

for command_name in git node npm uv uvx; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing prerequisite: $command_name" >&2
    exit 1
  fi
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"

if ((node_major < 22 || (node_major == 22 && node_minor < 22))); then
  echo "Node.js 22.22 or newer is required; found $(node --version)." >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "Installing the pinned Hermes runtime dependencies..."
uvx --from "uv==$UV_VERSION" uv sync --locked --python 3.11 --extra all --extra dev

echo "Installing the pinned desktop dependencies..."
npm ci

if [[ "$VERIFY" == true ]]; then
  echo "Checking the desktop source..."
  npm --workspace apps/desktop run typecheck
fi

if [[ "$RUN_APP" == true ]]; then
  echo "Launching Orgo AI Guy Bot..."
  exec npm --workspace apps/desktop run dev:bot
fi

cat <<'EOF'

Orgo AI Guy Bot is ready.

Launch it with:
  npm --workspace apps/desktop run dev:bot

The first-run guide will help connect Orgo, Tailscale, Codex or Grok, and your first bot.
EOF
