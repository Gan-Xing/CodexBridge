#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_linux
require_systemctl
require_unit_installed

systemctl --user status "${SERVICE_NAME}" --no-pager
