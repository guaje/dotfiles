#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$SCRIPT_DIR/merge-settings.sh" >/dev/null

if [ "${PI_REAL_BIN:-}" ]; then
  REAL_PI=$PI_REAL_BIN
else
  REAL_PI=$(command -v pi || true)
fi

if [ -z "${REAL_PI:-}" ] || [ "$REAL_PI" = "$0" ]; then
  echo "Could not find the real pi binary. Set PI_REAL_BIN to its path." >&2
  exit 1
fi

exec "$REAL_PI" "$@"
