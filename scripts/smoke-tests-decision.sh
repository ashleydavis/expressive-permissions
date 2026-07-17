#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLES_DIR="$SCRIPT_DIR/../examples/decision"
CHECK_SCRIPT="$SCRIPT_DIR/check-decision.ts"

passed=0
failed=0

for yaml_file in "$EXAMPLES_DIR"/*/index.yaml; do
    [ -f "$yaml_file" ] || continue
    name=$(basename "$(dirname "$yaml_file")")

    if error_output=$(bun "$CHECK_SCRIPT" "$name" 2>&1); then
        printf "PASS  %s\n" "$name"
        passed=$((passed + 1))
    else
        printf "FAIL  %s\n" "$name"
        printf "%s\n" "$error_output" | sed 's/^/      /'
        failed=$((failed + 1))
    fi
done

total=$((passed + failed))

if [ "$total" -eq 0 ]; then
    printf "No example files found in %s\n" "examples/decision"
    exit 1
fi

printf "\nTotal: %d  Passed: %d  Failed: %d\n" "$total" "$passed" "$failed"
[ "$failed" -eq 0 ]
