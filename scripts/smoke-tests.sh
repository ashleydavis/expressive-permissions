#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
while IFS= read -r yaml_file; do
    TOTAL=$((TOTAL + 1))
    if bun run "$SCRIPT_DIR/run-e2e-test.ts" "$yaml_file"; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
done < <(find "$PROJECT_DIR/e2e" -name "*.yaml" -not -path "*/fixtures/*" -not -path "*/tmp/*" | sort)
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
