#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_PATH=$SCRIPT_DIR
OUTPUT_FILE=$(mktemp)
trap 'rm -f "$OUTPUT_FILE"' EXIT HUP INT TERM

PROMPT='/skill:linkup-search Use only the loaded linkup-search skill. Do not call tools or access the web.
Return strict JSON only, with no markdown fences and no prose, using this exact top-level shape:
{
  "depths": {
    "fast": {"recommendedDepth": "fast", "scenario": "...", "reason": "..."},
    "standard": {"recommendedDepth": "standard", "scenario": "...", "reason": "..."},
    "deep": {"recommendedDepth": "deep", "scenario": "...", "reason": "..."}
  },
  "outputTypes": {
    "searchResults": {"outputType": "searchResults", "useWhen": "..."},
    "sourcedAnswer": {"outputType": "sourcedAnswer", "useWhen": "..."},
    "structured": {"outputType": "structured", "useWhen": "..."}
  },
  "fetch": {"endpoint": "/fetch", "renderJs": true, "useWhen": "..."},
  "dateFiltering": {"fromDate": "2025-01-01", "toDate": "2025-03-31", "useWhen": "..."},
  "domainFiltering": {"includeDomains": ["sec.gov"], "excludeDomains": ["example.com"], "useWhen": "..."}
}
Make each scenario/useWhen/reason accurately reflect the skill guidance.'

if [ -n "${PI_LINKUP_SKILL_MODEL:-}" ]; then
  pi -p \
    --no-tools \
    --no-extensions \
    --no-prompt-templates \
    --no-themes \
    --skill "$SKILL_PATH" \
    --model "$PI_LINKUP_SKILL_MODEL" \
    "$PROMPT" > "$OUTPUT_FILE"
else
  pi -p \
    --no-tools \
    --no-extensions \
    --no-prompt-templates \
    --no-themes \
    --skill "$SKILL_PATH" \
    "$PROMPT" > "$OUTPUT_FILE"
fi

COMPACT=$(tr -d '\n\r' < "$OUTPUT_FILE")
NOWS=$(printf '%s' "$COMPACT" | tr -d '[:space:]')

fail() {
  printf 'FAIL %s\n\nModel response:\n%s\n' "$1" "$(cat "$OUTPUT_FILE")" >&2
  exit 1
}

assert_contains() {
  pattern=$1
  message=$2
  printf '%s\n' "$COMPACT" | grep -Eq "$pattern" || fail "$message"
}

assert_not_contains() {
  pattern=$1
  message=$2
  if printf '%s\n' "$COMPACT" | grep -Eq "$pattern"; then
    fail "$message"
  fi
}

# Strict-response shape checks using POSIX shell utilities.
[ "$(printf '%s' "$NOWS" | cut -c 1)" = "{" ] || fail 'response must start with a JSON object'
[ "$(printf '%s' "$NOWS" | sed 's/.*\(.\)$/\1/')" = "}" ] || fail 'response must end with a JSON object'
assert_not_contains '```' 'response must not contain markdown fences'

# Search depths.
assert_contains '"depths"[[:space:]]*:' 'missing depths object'
assert_contains '"fast"[[:space:]]*:[[:space:]]*\{[^}]*"recommendedDepth"[[:space:]]*:[[:space:]]*"fast"' 'missing fast depth recommendation'
assert_contains '"standard"[[:space:]]*:[[:space:]]*\{[^}]*"recommendedDepth"[[:space:]]*:[[:space:]]*"standard"' 'missing standard depth recommendation'
assert_contains '"deep"[[:space:]]*:[[:space:]]*\{[^}]*"recommendedDepth"[[:space:]]*:[[:space:]]*"deep"' 'missing deep depth recommendation'
assert_contains '"fast"[[:space:]]*:[[:space:]]*\{[^}]*"[^"]*(single|specific|focused|latency|sub-second|one)[^"]*"' 'fast guidance should mention a focused/single low-latency lookup'
assert_contains '"standard"[[:space:]]*:[[:space:]]*\{[^}]*"[^"]*(parallel|one URL|single URL|snippets|provided URL|one url|single url)[^"]*"' 'standard guidance should mention snippets, parallel search, or one provided URL'
assert_contains '"deep"[[:space:]]*:[[:space:]]*\{[^}]*"[^"]*(chain|sequential|multiple URLs|multiple urls|find|then scrape|iterative)[^"]*"' 'deep guidance should mention sequential chaining, finding then scraping, or multiple URLs'

# Output types.
assert_contains '"outputTypes"[[:space:]]*:' 'missing outputTypes object'
assert_contains '"searchResults"[[:space:]]*:[[:space:]]*\{[^}]*"outputType"[[:space:]]*:[[:space:]]*"searchResults"' 'missing searchResults output type'
assert_contains '"sourcedAnswer"[[:space:]]*:[[:space:]]*\{[^}]*"outputType"[[:space:]]*:[[:space:]]*"sourcedAnswer"' 'missing sourcedAnswer output type'
assert_contains '"structured"[[:space:]]*:[[:space:]]*\{[^}]*"outputType"[[:space:]]*:[[:space:]]*"structured"' 'missing structured output type'
assert_contains '"searchResults"[[:space:]]*:[[:space:]]*\{[^}]*"[^"]*(raw|sources|synthesize|process)[^"]*"' 'searchResults guidance should mention raw sources or agent-side processing'
assert_contains '"sourcedAnswer"[[:space:]]*:[[:space:]]*\{[^}]*"[^"]*(answer|user|citations|chatbot)[^"]*"' 'sourcedAnswer guidance should mention user-facing answers or citations'
assert_contains '"structured"[[:space:]]*:[[:space:]]*\{[^}]*"[^"]*(JSON|json|schema|parse|pipeline|CRM|crm)[^"]*"' 'structured guidance should mention JSON/schema/parsing/pipelines'

# Fetch endpoint.
assert_contains '"fetch"[[:space:]]*:' 'missing fetch object'
assert_contains '"endpoint"[[:space:]]*:[[:space:]]*"/fetch"' 'missing /fetch endpoint'
assert_contains '"renderJs"[[:space:]]*:[[:space:]]*true' 'missing renderJs true'
assert_contains '"fetch"[[:space:]]*:[[:space:]]*\{[^}]*"[^"]*(known URL|exact URL|single|specific URL|known url|exact url|specific url)[^"]*"' 'fetch guidance should mention a known/exact/single URL'

# Date filtering.
assert_contains '"dateFiltering"[[:space:]]*:' 'missing dateFiltering object'
assert_contains '"fromDate"[[:space:]]*:[[:space:]]*"2025-01-01"' 'missing fromDate'
assert_contains '"toDate"[[:space:]]*:[[:space:]]*"2025-03-31"' 'missing toDate'
assert_contains '"dateFiltering"[[:space:]]*:[[:space:]]*\{[^}]*"[^"]*(date|time|window|range)[^"]*"' 'date filtering guidance should mention date/time window usage'

# Domain filtering.
assert_contains '"domainFiltering"[[:space:]]*:' 'missing domainFiltering object'
assert_contains '"includeDomains"[[:space:]]*:[[:space:]]*\[[^]]*"sec\.gov"' 'missing includeDomains sec.gov'
assert_contains '"excludeDomains"[[:space:]]*:[[:space:]]*\[[^]]*"example\.com"' 'missing excludeDomains example.com'
assert_contains '"domainFiltering"[[:space:]]*:[[:space:]]*\{[^}]*"[^"]*(domain|source|noise|focus)[^"]*"' 'domain filtering guidance should mention domains, sources, focus, or noise removal'

printf 'PASS live pi skill invocation covers depths, output types, fetch, date filtering, and domain filtering\n'
