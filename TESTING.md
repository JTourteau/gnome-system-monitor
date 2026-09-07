# Testing

## Principle: maximize the offline-testable surface

A GNOME Shell extension mixes two very different kinds of code:

- **Pure logic** — parsing `/proc` and sysfs text, computing rates from
  counter snapshots, formatting numbers, threshold colors. This needs no GNOME
  runtime and can be tested with plain `node`.
- **Runtime/UI glue** — `St`, `PanelMenu`, `Clutter`, `Gio` file IO and
  subprocesses, the panel button and menu. This only runs inside GNOME Shell.

All the pure logic is isolated in **`lib/metrics.js`**, which has **no `gi://`
import**: the async readers in `extension.js` keep the `Gio` file IO and hand
the raw text to `lib/metrics.js` for parsing/formatting. That keeps the
number-crunching — where bugs actually hide — fully unit-testable.
`extension.js` and `prefs.js` are only syntax-checked offline; their runtime
behavior is confirmed by a nested-shell smoke test.

## Layers

| Layer | Tool | Covers | Where |
|-------|------|--------|-------|
| Static — metadata | `node` | required `metadata.json` fields, non-empty `shell-version` | `run-tests.sh` |
| Static — schema | `glib-compile-schemas --strict` | the GSettings schema compiles | `run-tests.sh` |
| Static — syntax | `node --check` | `lib/metrics.js`, `extension.js`, `prefs.js` parse as ESM | `run-tests.sh` |
| Unit | `node --test` | `lib/metrics.js` (see coverage map below) | `tests/metrics.test.js` |
| Smoke — gjs | `gjs -m` | pure logic runs in the real GNOME JS engine, not just node | manual (see below) |
| Smoke — runtime | nested `gnome-shell` | the extension loads to `State: ACTIVE` and renders live metrics | manual (see below) |

## Coverage map — `lib/metrics.js`

| Function | Tested behavior |
|----------|-----------------|
| `parseCpuTimes` | `/proc/stat` → idle/total jiffies; stops at first non-cpu line; `null` passthrough |
| `getCpuUsage` | percent between two snapshots; null and zero-delta guards |
| `parseMeminfo` | `/proc/meminfo` → percent, GB strings, swap; no divide-by-zero on absent swap |
| `parseDiskIO` | `/proc/diskstats` → keeps whole disks, drops partitions / nvme partitions / dm / loop / sr |
| `getDiskIORate` | bytes/s between snapshots; skips devices absent from prev; null guard |
| `parseNetIO` | `/proc/net/dev` → skips 2 header lines, `lo`, `veth*` |
| `getNetIORate` | bytes/s between snapshots; null guard |
| `formatBytes` / `formatBytesShort` | unit boundaries (B/KB/MB/GB) |
| `parseNvidiaOutput` | nvidia-smi CSV → object; `<6` fields → null |
| `getRaplPower` | watts from µJ delta; counter wraparound; invalid-input guards |
| `formatTemp`, `getTempColor`, `getUsageColor` | thresholds and N/A |

## Running the offline suite

```bash
./run-tests.sh      # or: npm test
```

Runs everywhere `node` and `glib-compile-schemas` are available; no GNOME
session required. Exits non-zero on the first failing layer.

## Runtime smoke (needs a GNOME session)

### gjs smoke (safe, no window)

Confirms `lib/metrics.js` behaves identically under gjs (the engine GNOME Shell
uses) as under node:

```bash
gjs -m - <<'EOF'
import { formatBytes, getCpuUsage, parseCpuTimes } from './lib/metrics.js';
if (formatBytes(2048) !== '2.0 KB/s') throw new Error('formatBytes');
if (getCpuUsage({idle:100,total:1000},{idle:150,total:1200}) !== 75) throw new Error('getCpuUsage');
if (parseCpuTimes('cpu 100 0 100 700 100\nintr 1')[0].total !== 1000) throw new Error('parseCpuTimes');
print('gjs smoke OK');
EOF
```

### Nested-shell smoke (opens a window)

Load the extension in a **fully sandboxed** nested GNOME Shell (its own XDG dirs
+ session bus + dconf — the host GNOME is never touched) and confirm it reaches
`State: ACTIVE` and renders the metrics in the nested top bar:

```bash
SB=$(mktemp -d)
export XDG_CONFIG_HOME=$SB/config XDG_DATA_HOME=$SB/data XDG_CACHE_HOME=$SB/cache XDG_STATE_HOME=$SB/state
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions"
ln -s "$PWD" "$XDG_DATA_HOME/gnome-shell/extensions/system-monitor@jtourteau"
export MUTTER_DEBUG_DUMMY_MODE_SPECS=1400x900 WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}
dbus-run-session -- bash -c '
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions "[\"system-monitor@jtourteau\"]"
  gsettings set org.gnome.shell welcome-dialog-last-shown-version "99.0"
  gnome-shell --nested --wayland &
  sleep 10
  gnome-extensions info system-monitor@jtourteau | grep State   # expect: State: ACTIVE
'
trash "$SB"
```

The top bar of the nested window should show live CPU / RAM / temperature /
disk / I/O / network / GPU / power readings.

## What is intentionally NOT automated

- **The UI itself** (the panel button, the scrollable menu, per-core/partition
  rows): would require mocking all of GNOME Shell. The nested smoke covers "does
  it build and render without throwing"; visual correctness is a human check.
- **Live sensor values**: they depend on the host's hardware and `/proc` state,
  which are not reproducible in a test. The *parsing* of representative sensor
  text is what the unit tests pin down.

## Automation

- **git pre-commit** (`.githooks/pre-commit`, enabled via
  `git config core.hooksPath .githooks`) runs `run-tests.sh` and blocks the
  commit on failure.
- **Claude Code PostToolUse hook** (`.claude/settings.local.json` →
  `dev/claude-test-hook.sh`) runs the suite after edits inside the project and
  feeds failures back to the assistant. (`.claude/` is gitignored here, so this
  hook is local-only.)

## Packaging note

`lib/` is part of the runtime and **must** ship in the installed/zipped
extension — it is listed in the `Makefile` `FILES`. Removing it would break the
`./lib/metrics.js` import at load time.
