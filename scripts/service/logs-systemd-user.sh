#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_linux
require_journalctl
require_unit_installed

FOLLOW=0
LINES=200

while (($# > 0)); do
  case "$1" in
    -f|--follow)
      FOLLOW=1
      shift
      ;;
    -n|--lines)
      if (($# < 2)); then
        echo "missing value for $1" >&2
        exit 1
      fi
      LINES="$2"
      shift 2
      ;;
    *)
      echo "Usage: $0 [--follow] [--lines N]" >&2
      exit 1
      ;;
  esac
done

if ((FOLLOW)); then
  journalctl --user -u "${SERVICE_NAME}" -n "${LINES}" -f
else
  journalctl --user -u "${SERVICE_NAME}" -n "${LINES}"
fi
