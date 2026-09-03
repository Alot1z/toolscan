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
toolscan                    # JSON: all tools (PATH first, then roots)
toolscan --name 'git*'      # wildcard filter, case-insensitive
toolscan --roots ~/bin,/opt/x/bin --depth 1
toolscan --no-path          # roots only
toolscan --quiet            # names only, one per line
toolscan --max-files 5000   # tighten the budget
```

Exit codes: `0` full scan, `2` scan truncated by a budget (truthful signal —
the output says so too).

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