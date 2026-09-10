#!/usr/bin/env bash
# Hourly incremental until a cron daemon exists on this box.
set -euo pipefail
while true; do
  /root/arena/Tazor/product-metrics/scripts/run_incremental.sh || true
  sleep 3600
done
