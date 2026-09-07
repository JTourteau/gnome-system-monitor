#!/usr/bin/env bash
# Full offline test suite for System Monitor. Runs anywhere node +
# glib-compile-schemas are available; no GNOME Shell session required.
set -uo pipefail
cd "$(dirname "$0")"

fail=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

step "metadata.json: valid JSON + required fields"
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync("metadata.json", "utf8"));
  const required = ["uuid", "name", "description", "shell-version", "settings-schema"];
  for (const k of required)
    if (!(k in m)) { console.error("  missing field:", k); process.exit(1); }
  if (!Array.isArray(m["shell-version"]) || m["shell-version"].length === 0) {
    console.error("  shell-version must be a non-empty array"); process.exit(1);
  }
  console.log("  ok:", m.uuid, "v" + (m["version-name"] ?? m["version"] ?? "?"));
' || fail=1

step "GSettings schema: compiles (strict) + rebuilds gschemas.compiled"
if glib-compile-schemas --strict schemas/; then
  echo "  ok: schemas/gschemas.compiled"
else
  echo "  FAIL: schema did not compile"; fail=1
fi

step "JS: ESM syntax parse"
for f in lib/metrics.js extension.js prefs.js; do
  if node --check "$f"; then echo "  ok: $f"; else echo "  FAIL: $f"; fail=1; fi
done

step "Unit tests: lib/metrics.js"
node --test tests/metrics.test.js || fail=1

if [ "$fail" -ne 0 ]; then
  printf '\n\033[31m✗ TESTS FAILED\033[0m\n'; exit 1
fi
printf '\n\033[32m✓ ALL TESTS PASSED\033[0m\n'
