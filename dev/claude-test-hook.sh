#!/usr/bin/env bash
# PostToolUse hook: when Claude edits a file inside this project, run the test
# suite. On success stay silent; on failure emit a "block" decision so the test
# output is fed back to Claude to fix before moving on.
#
# Reads the hook payload (JSON) on stdin; the edited path is at
# .tool_input.file_path (Write/Edit) or .tool_response.filePath.
set -uo pipefail

# Resolve the project root from this script's location (dev/ -> project root),
# so the hook has no machine-specific hardcoded path.
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

file="$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')"

# Only react to edits inside this project.
case "$file" in
    "$PROJECT"/*) ;;
    *) exit 0 ;;
esac

if out="$(cd "$PROJECT" && ./run-tests.sh 2>&1)"; then
    exit 0
fi

# Tests failed: hand the output back to Claude.
jq -n --arg r "System Monitor tests failed after editing ${file}:"$'\n\n'"${out}" \
    '{decision: "block", reason: $r}'
