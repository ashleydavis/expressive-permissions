#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
HOOK_JS="$PROJECT_DIR/plugin/dist/pre-hook.js"

echo "Building bundle..."
(cd "$PROJECT_DIR" && bun run bundle) || { echo "Build failed" >&2; exit 1; }

PASS=0
FAIL=0
TMPDIR_HOOK="$(mktemp -d)"
export CLAUDE_PROJECT_DIR="$TMPDIR_HOOK"

run_test() {
    local description="$1"
    local input="$2"
    local expected_exit="$3"

    printf 'Test: %s ... ' "$description"
    printf '%s' "$input" | bun "$HOOK_JS" > /tmp/hook-smoke-out.txt 2>/tmp/hook-smoke-err.txt
    local actual_exit=$?

    if [ "$actual_exit" -eq "$expected_exit" ]; then
        echo "PASS"
        PASS=$((PASS + 1))
    else
        echo "FAIL (expected exit $expected_exit, got $actual_exit)"
        cat /tmp/hook-smoke-err.txt >&2
        FAIL=$((FAIL + 1))
    fi
}

run_test_output() {
    local description="$1"
    local input="$2"
    local expected_key="$3"
    local expected_value="$4"

    printf 'Test: %s ... ' "$description"
    local output
    output=$(printf '%s' "$input" | bun "$HOOK_JS" 2>/tmp/hook-smoke-err.txt)
    local actual_exit=$?

    if [ "$actual_exit" -ne 0 ]; then
        echo "FAIL (expected exit 0, got $actual_exit)"
        cat /tmp/hook-smoke-err.txt >&2
        FAIL=$((FAIL + 1))
        return
    fi

    local actual_value
    actual_value=$(printf '%s' "$output" | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String(d.$expected_key))" 2>/dev/null)

    if [ "$actual_value" = "$expected_value" ]; then
        echo "PASS"
        PASS=$((PASS + 1))
    else
        echo "FAIL (expected $expected_key=$expected_value, got $actual_value)"
        FAIL=$((FAIL + 1))
    fi
}

run_test "malformed JSON exits 1" "not valid json" 1
run_test "empty input exits 1" "" 1
run_test_output \
    "valid Read ToolCall exits 0 with PreToolUse event" \
    '{"tool_name":"Read","tool_input":{"file_path":"/test.txt"},"cwd":"/home/user"}' \
    "hookSpecificOutput.hookEventName" \
    "PreToolUse"

rm -rf "$TMPDIR_HOOK"

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
