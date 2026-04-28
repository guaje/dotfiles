#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_FILE=$SCRIPT_DIR/SKILL.md

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

[ -f "$SKILL_FILE" ] || fail 'SKILL.md must exist'

NAME=$(sed -n 's/^name: *//p' "$SKILL_FILE" | head -n 1 | tr -d '"' | tr -d "'")
[ "$NAME" = "$(basename "$SCRIPT_DIR")" ] || fail 'name must match parent directory'
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

assert_desc_contains 'search the web' 'description should match prompts asking to search the web'
assert_desc_contains 'scout the web|web scouting' 'description should match prompts asking to scout the web'
assert_desc_contains 'fetch the content from|URL content fetching|/fetch' 'description should match prompts asking to fetch content from a URL'
assert_desc_contains 'look .*up online|current|recent|research|gather sources' 'description should cover common web-research wording'
assert_desc_contains 'linkup-search' 'description should mention the Linkup search tool'
assert_desc_contains 'linkup-fetch|/fetch' 'description should mention the Linkup fetch tool or endpoint'

printf 'PASS linkup-search frontmatter is valid and discoverable\n'
