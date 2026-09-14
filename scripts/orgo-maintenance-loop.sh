#!/bin/bash
set -Eeuo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
MAINTENANCE="${ORGO_MAINTENANCE_COMMAND:-/usr/local/sbin/orgo-remote-maintenance}"

# Schedule: 03:30 UTC with up to 15 minutes of jitter.
while true; do
  delay="$(python3 -c 'from datetime import datetime, timedelta, timezone; import secrets; now=datetime.now(timezone.utc); target=now.replace(hour=3, minute=30, second=0, microsecond=0); target=target if target>now else target+timedelta(days=1); print(max(1, int((target-now).total_seconds())+secrets.randbelow(901)))')"
  sleep "$delay"
  "$MAINTENANCE" || true
done
