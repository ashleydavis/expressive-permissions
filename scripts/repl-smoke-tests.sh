#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

# run_test executes a one-shot REPL invocation and checks stdout for the expected word.
# Usage: run_test <description> <project_dir> <command> <expected_word>
run_test() {
    local description="$1"
    local project_dir="$2"
    local command="$3"
    local expected="$4"

    local output
    output=$(CLAUDE_PROJECT_DIR="$project_dir" bun run src/repl.ts "$command" 2>/dev/null)

    if echo "$output" | grep -q "$expected"; then
        echo "PASS: $description"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $description (expected '$expected', got: $output)"
        FAIL=$((FAIL + 1))
    fi
}

# ---- Test 1: git status with allow rule -> ALLOW ----
TMP1=$(mktemp -d)
mkdir -p "$TMP1/.claude"
cat > "$TMP1/.claude/permissions.yaml" <<'YAML'
bash:
  git:
    - decide: allow
YAML
run_test "git status with allow rule" "$TMP1" "git status" "ALLOW"
rm -rf "$TMP1"

# ---- Test 2: rm with deny rule -> DENY ----
TMP2=$(mktemp -d)
mkdir -p "$TMP2/.claude"
cat > "$TMP2/.claude/permissions.yaml" <<'YAML'
bash:
  rm:
    - decide: deny
      reason: rm is not allowed
YAML
run_test "rm -rf / with deny rule" "$TMP2" "rm -rf /" "DENY"
rm -rf "$TMP2"

# ---- Test 3: ls /tmp with no matching rule -> ASK ----
# Override HOME to an empty dir so ~/.claude/permissions.yaml does not interfere.
TMP3=$(mktemp -d)
TMP3_HOME=$(mktemp -d)
mkdir -p "$TMP3/.claude"
original_home="$HOME"
export HOME="$TMP3_HOME"
run_test "ls /tmp with no matching rule" "$TMP3" "ls /tmp" "ASK"
export HOME="$original_home"
rm -rf "$TMP3" "$TMP3_HOME"

# ---- Test 4: Read /etc/passwd with allow rule -> ALLOW ----
TMP4=$(mktemp -d)
mkdir -p "$TMP4/.claude"
cat > "$TMP4/.claude/permissions.yaml" <<'YAML'
read:
  - decide: allow
YAML
run_test "Read /etc/passwd with allow rule" "$TMP4" "read /etc/passwd" "ALLOW"
rm -rf "$TMP4"

# ---- Test 5: Write /etc/passwd with deny rule -> DENY ----
TMP5=$(mktemp -d)
mkdir -p "$TMP5/.claude"
cat > "$TMP5/.claude/permissions.yaml" <<'YAML'
write:
  - decide: deny
    reason: writes not allowed
YAML
run_test "Write /etc/passwd with deny rule" "$TMP5" "write /etc/passwd" "DENY"
rm -rf "$TMP5"

# ---- Test 6: WebFetch with host allow rule -> ALLOW ----
TMP6=$(mktemp -d)
mkdir -p "$TMP6/.claude"
cat > "$TMP6/.claude/permissions.yaml" <<'YAML'
webfetch:
  - host: api.example.com
    decide: allow
YAML
run_test "WebFetch api.example.com with host allow rule" "$TMP6" "webfetch https://api.example.com/v1" "ALLOW"
rm -rf "$TMP6"

echo ""
echo "Results: $PASS/$((PASS + FAIL)) passed"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
