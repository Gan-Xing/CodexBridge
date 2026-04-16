#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_linux
require_systemctl
require_node_bin

ensure_service_env_file
render_unit_file
stop_manual_weixin_runtime

systemctl --user daemon-reload
systemctl --user enable --now "${SERVICE_NAME}"

echo "Installed ${SYSTEMD_UNIT_PATH}"
echo "Environment file: ${SERVICE_ENV_FILE}"
echo "Check status: systemctl --user status ${SERVICE_NAME} --no-pager"
