#!/usr/bin/env bash
set -euo pipefail

LABEL="${LABEL:-com.ganxing.codexbridge-weixin}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd user services are only supported on macOS" >&2
  exit 1
fi

launchctl kickstart -k "gui/${UID}/${LABEL}"
echo "Restarted ${LABEL}"
