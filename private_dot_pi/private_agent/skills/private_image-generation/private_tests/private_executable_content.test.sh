#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SKILL_FILE=$SKILL_DIR/SKILL.md

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  pattern=$1
  message=$2
  grep -Eq "$pattern" "$SKILL_FILE" || fail "$message"
}

assert_not_contains() {
  pattern=$1
  message=$2
  if grep -Eq "$pattern" "$SKILL_FILE"; then
    fail "$message"
  fi
}

assert_contains 'Read `agent/model-health-cache\.json`' 'skill should require reading the model health cache before use'
assert_contains 'MODEL_HEALTH_CACHE_TTL_MS' 'skill should use the extension cache TTL when judging freshness'
assert_contains 'model-health-check\.ts' 'skill should reference model-health-check.ts for cache staleness'
assert_contains 'service` is `imageGeneration`|service == "imageGeneration"' 'skill should filter image generation health results'
assert_contains 'status` is `ok`|status == "ok"' 'skill should require ok health status'
assert_contains 'no image generation models are currently available|No image generation models are currently available' 'skill should fail clearly when no healthy image models are available'
assert_contains '/model-health' 'skill should tell the user how to refresh health results'
assert_contains 'imageGenerationProviders' 'skill should use configured image generation provider settings'
assert_contains 'agent/models\.json' 'skill should use models.json for provider connection details'
assert_contains '/images/generations' 'skill should document the image generation endpoint'
assert_contains 'response_format.*b64_json|b64_json.*response_format' 'skill should request base64 output by default'
assert_contains 'Never include the key' 'skill should protect API keys'
assert_contains 'inline terminal image rendering' 'skill should use pi inline image rendering in supported terminals'
assert_contains '@mariozechner/pi-tui' 'skill should reference pi TUI image components for previews'
assert_contains 'context\.showImages' 'skill should respect pi image display context'
assert_contains 'delayed background|Scheduled image open|sleep' 'skill should open Termux images via a delayed background opener'
assert_contains 'IMAGE_OPEN_DELAY_SECONDS' 'script should allow configuring Termux image open delay'
assert_contains 'am start.*android\.intent\.action\.VIEW|android\.intent\.action\.VIEW.*am.*start' 'skill should provide Android activity manager command for generated images in Termux'
assert_contains 'file://.*image/png|image/png.*file://' 'skill should provide Termux image file URI and image/png MIME type'
assert_contains 'termux-open --chooser --content-type image/png' 'skill should provide termux-open fallback for generated images in Termux'
assert_contains 'fall back|fallback|If that fails' 'skill should provide fallbacks when Termux image open fails'
assert_contains 'dirname\(imagePath\)|generatedImageDirectory|generated image folder' 'skill should fall back to opening the generated image folder in Termux'
assert_not_contains 'termux-open -c' 'skill should not use unsupported termux-open -c option'
assert_contains 'TERMUX_VERSION|com\.termux|Termux' 'skill should describe Termux detection'
assert_contains 'Do not claim an image was generated unless' 'skill should require healthy cache and successful write before claiming success'
assert_contains 'IMAGE_MODEL' 'script should allow model override without hardcoded IDs'
assert_contains 'IMAGE_PROVIDER' 'script should allow provider override without hardcoded IDs'
assert_contains 'IMAGE_OUT_DIR' 'script should allow output directory override'
assert_contains 'Pictures.*generated|pictures.*generated|xdg-user-dir.*PICTURES' 'skill should default to the OS Pictures directory generated subdirectory'
assert_not_contains 'gpt-image-1|dall-e|imagen-[0-9]|flux|sdxl' 'skill should not hardcode real image model IDs'

printf 'PASS image-generation content covers health-aware image generation workflow\n'
