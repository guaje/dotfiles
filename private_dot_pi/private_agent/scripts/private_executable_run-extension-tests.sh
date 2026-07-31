#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

find agent/extensions -name '*.test.ts' -print | sort | while IFS= read -r test_file; do
  npx -y tsx --test "$test_file"
done

find agent -name '*.test.mjs' -print | sort | while IFS= read -r test_file; do
  node --test "$test_file"
done

python3 -m unittest discover -s agent/extensions/02-handoff/tests -p 'test_*.py'

find agent -name '*.test.sh' -print | sort | while IFS= read -r test_file; do
  sh "$test_file"
done
