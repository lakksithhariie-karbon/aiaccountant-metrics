#!/usr/bin/env bash
set -euo pipefail
cd /root/arena/Tazor/product-metrics
export PYTHONUNBUFFERED=1
log=/var/log/pm-incremental.log
if [ ! -w "$log" ] && [ ! -e "$log" ]; then
  log=/tmp/pm-incremental.log
fi
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) incremental start" >> "$log"
exec flock -n /tmp/pm-incremental.lock \
  /root/arena/Tazor/product-metrics/.venv/bin/python -m fetcher incremental --request-gap 120 \
  >> "$log" 2>&1
