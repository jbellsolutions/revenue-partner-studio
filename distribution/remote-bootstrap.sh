#!/usr/bin/env bash
# Run only through the source installer on a fresh, explicitly dedicated Orgo host.
set -euo pipefail
umask 077
cd /opt/hermes-orgo-studio
[[ $(id -u) == 0 && $(uname -s) == Linux ]]
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]]
command -v node >/dev/null
command -v npm >/dev/null
test -x /usr/bin/google-chrome
# Existing root Hermes data is never overwritten. A failed bootstrap leaves its
# checkpoint for inspection; there is no destructive automatic retry.
test ! -e /root/.hermes/config.yaml
test ! -e /root/.hermes/auth.json
test ! -e /root/.hermes/state.db
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends python3-venv tigervnc-standalone-server xfwm4 websockify xdotool xclip scrot supervisor
command -v Xvnc >/dev/null || ln -s /usr/bin/Xtigervnc /usr/local/bin/Xvnc
python3 -m venv bootstrap-venv
bootstrap-venv/bin/pip install --disable-pip-version-check uv==0.12.7
UV_PROJECT_ENVIRONMENT=venv bootstrap-venv/bin/uv sync --frozen --python 3.11 --extra mcp --extra anthropic --no-dev
npm ci --prefix distribution/computer-tools
ln -s distribution/computer-tools computer-tools
venv/bin/python distribution/initialize_remote.py "$1"
install -m 700 distribution/studio-serve studio-serve
install -m 600 distribution/studio.conf /etc/supervisor/conf.d/studio.conf
supervisorctl reread
supervisorctl update
sleep 6
supervisorctl status hermes-studio
venv/bin/python scripts/studio_remote_rpc.py --computer-id "$1" studio.snapshot '{}' >/dev/null
printf '%s\n' 'Studio service verified. Provider authentication is still required.'
