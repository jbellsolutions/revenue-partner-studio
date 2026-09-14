#!/usr/bin/env bash
# Run from the approved, prepared runtime on the already-bound Orgo computer.
# This never provisions a VM, buys credits, changes models, or restarts Hermes.
set -euo pipefail
if [[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]]; then
  echo 'Run this installer as root on the bound Orgo Linux computer, not the Mac.' >&2
  exit 1
fi
runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$runtime_dir" in /root/.hermes/desktop-runtime/*) ;; *) echo 'Use a prepared runtime.' >&2; exit 1 ;; esac
[[ $# -ge 2 ]] || { echo 'Usage: setup-orgo-subscription-worker.sh COMPUTER_ID PROFILE [PROFILE ...]' >&2; exit 1; }
computer_id="$1"; shift
for executable in node npm Xvnc xfwm4 xdotool google-chrome websockify; do
  command -v "$executable" >/dev/null || { echo "Missing cloud prerequisite: $executable" >&2; exit 1; }
done
"$runtime_dir/.venv/bin/python" -c 'import PIL, dotenv, mcp, websockets'
npm install --prefix /root/.hermes/codex-worker --ignore-scripts --no-audit --no-fund --save-exact \
  @openai/codex@0.153.1 agent-browser@0.26.0 orgo-mcp-server@1.1.1
export PYTHONPATH="$runtime_dir"
"$runtime_dir/.venv/bin/python" -m hermes_cli.orgo_worker_install \
  --runtime "$runtime_dir" --computer-id "$computer_id" --profiles "$@"
echo 'Installed without restarting Hermes. Verify ChatGPT login on this cloud host before activation.'
/root/.hermes/codex-worker/node_modules/.bin/codex login status
