#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SKILL_FILE=$SKILL_DIR/SKILL.md

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

[ -f "$SKILL_FILE" ] || fail 'SKILL.md must exist'

NAME=$(sed -n 's/^name: *//p' "$SKILL_FILE" | head -n 1 | tr -d '"' | tr -d "'")
[ "$NAME" = "$(basename "$SKILL_DIR")" ] || fail 'name must match parent directory'
printf '%s' "$NAME" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$' || fail 'name must use lowercase letters, numbers, and hyphens only'

DESCRIPTION_LINE=$(sed -n 's/^description: *//p' "$SKILL_FILE" | head -n 1)
[ -n "$DESCRIPTION_LINE" ] || fail 'description must be present'
DESCRIPTION=$(printf '%s' "$DESCRIPTION_LINE" | sed "s/^['\"]//; s/['\"]$//")
DESC_LEN=$(printf '%s' "$DESCRIPTION" | wc -c | tr -d ' ')
[ "$DESC_LEN" -le 1024 ] || fail 'description must be at most 1024 characters'

assert_desc_contains() {
  pattern=$1
  message=$2
  printf '%s\n' "$DESCRIPTION" | grep -Eiq "$pattern" || fail "$message"
}

assert_desc_contains 'generate images|image generation' 'description should match image generation requests'
assert_desc_contains 'create|generate|render|draw|make' 'description should cover common creation wording'
assert_desc_contains 'logo|icon|poster|mockup|visual asset' 'description should cover common visual asset types'
assert_desc_contains 'agent/models\.json' 'description should mention configured models source'

printf 'PASS image-generation frontmatter is valid and discoverable\n'
