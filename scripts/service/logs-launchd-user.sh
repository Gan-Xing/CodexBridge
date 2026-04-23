#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${CODEXBRIDGE_STATE_DIR:-${HOME}/.codexbridge}"
LOG_DIR="${STATE_DIR}/logs"
STDOUT_LOG="${SERVICE_STDOUT_LOG:-${LOG_DIR}/weixin-bridge.out.log}"
STDERR_LOG="${SERVICE_STDERR_LOG:-${LOG_DIR}/weixin-bridge.err.log}"
FOLLOW=0
if [[ "${1:-}" == "--follow" ]]; then
  FOLLOW=1
fi

echo "== ${STDOUT_LOG} =="
tail -n 80 "${STDOUT_LOG}" 2>/dev/null || true
echo "== ${STDERR_LOG} =="
if [[ "${FOLLOW}" -eq 1 ]]; then
  tail -n 80 -f "${STDERR_LOG}"
else
  tail -n 80 "${STDERR_LOG}" 2>/dev/null || true
fi
