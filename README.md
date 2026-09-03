# toolscan

Cross-platform tool discovery: finds every executable on your `PATH`, then walks
XDG + common tool directories — JSON out, **zero dependencies**, read-only.

```
$ toolscan | head -20
{
  "ok": true,
  "elapsedMs": 14,
  "truncated": false,
  "pathEntries": 9,
  "tools": [ { "name": "git", "path": "C:\\Program Files\\Git\\cmd\\git.exe", "source": "PATH" }, ... ]
}
```

## Why

Extracted from WEP (`Alot1z/windows-environment-paths`): WEP's discovery walker
carried the right discipline — bounded scans (depth / file count / wall-clock),
shared noise-dir exclusions, and *truthful* reporting (`truncated` instead of
silent omission). The PATH manager itself is Windows-only by design; the
discovery idea is not. This tool is that idea, rewritten fresh, cross-platform,
with nothing else carried over.

## Usage

```
toolscan                          # JSON: all tools (PATH first, then roots)
toolscan list                     # names only, one per line
toolscan snapshot --out before.json   # save a scan for later comparison
toolscan diff before.json after.json  # added / removed / moved tools; exit 1
                                        # when anything changed (CI-friendly)
toolscan check git                 # print the resolved path; exit 0/1
toolscan missing --from tools.txt  # report names from a list not on the system
```

Shared flags: `--name 'git*'` (wildcard filter), `--roots a,b` (extra roots),
`--no-path`, `--depth N`, `--max-files N`, `--max-ms N`, `--quiet`.

Exit codes: `0` clean, `1` command found a difference (diff/missing/check),
`2` scan truncated by a budget (truthful signal — the output says so too).

## Semantics

- **PATH is authoritative.** First hit per tool name wins; root-scan finds are
  only added when the name is not already on PATH.
- **Executables** = `PATHEXT` extensions on Windows (default
  `.COM;.EXE;.BAT;.CMD`); the `X_OK` bit on POSIX.
- **Bounded**: 2-level BFS over roots, 8s wall clock, 20 000 files — all
  overridable. `.git`, `node_modules`, `AppData`-style noise dirs are skipped.
- **Zero dependencies**, Node ≥ 18. Read-only — never writes, never executes.

## Tests

```
npm test        # hermetic: temp-dir fixtures, no real PATH dependence
```