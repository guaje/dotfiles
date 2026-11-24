#!/bin/sh
# fake-sync-bin — stands in for herdr-sync.sh so the hooks can be tested for real.
# Logs one line per invocation, so a test can prove the shell actually called it.
printf '%s\n' "$*" >> "${FAKE_SYNC_LOG:?FAKE_SYNC_LOG must be set}"
