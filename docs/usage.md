# toolscan — usage

```
toolscan                       scan PATH + roots, JSON to stdout
toolscan list                  names only, one per line
toolscan check <name>          print the resolved path; exit 0 found / 1 not
toolscan snapshot [--out F]    save a snapshot (default ./toolscan-snapshot.json)
toolscan diff A.json [B.json]  added/removed/changed (B defaults to a live scan);
                               exit 1 when anything changed; --moves detects renames
toolscan missing --from F      report names (newline/comma list) not found; exit 1
toolscan drift --baseline B [--out O]  scan, compare against a saved snapshot,
                               rewrite the baseline, exit 1 when drifted (2 = truncated)
```

## Flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--name GLOB` | scan family | filter by name glob (`tool-*`, case-insensitive) |
| `--roots A,B` | scan family | scan these roots instead of the defaults |
| `--no-path` | scan family | skip the PATH scan |
| `--no-roots` | scan family | skip the roots scan (hermetic testing, PATH-only) |
| `--depth N` | scan family | root scan depth bound (default 2) |
| `--max-ms N` | scan family | time budget (default 8000) |
| `--max-files N` | scan family | file budget (default 20000) |
| `--quiet` | list/scan/check/snapshot | names only / no success prints |
| `--format json\|text` | scan | JSON (default) or `name<TAB>path<TAB>source` lines |
| `--moves` | diff, drift | detect renames by bounded content hash |
| `--out F` | snapshot | output file (default `./toolscan-snapshot.json`) |
| `--from F` | missing | name list file (newline or comma separated) |
| `--baseline B` | drift | snapshot to compare against (also `--out` target) |

## Exit codes

- `0` — success; nothing changed / nothing missing / not truncated
- `1` — a real difference: tool missing, drift detected, `check` miss
- `2` — the scan was **truncated** (budget exceeded): the answer is partial.
  `drift` refuses to write a truncated scan as the new baseline.

## Examples

```bash
toolscan                              # JSON scan of PATH + common roots
toolscan --name "claude*"             # only matching names
toolscan list                         # names only
toolscan check node                   # print resolved path, exit 0/1
toolscan snapshot --out machine.json  # baseline this machine
toolscan diff machine.json            # what changed since? exit 1 when anything
toolscan diff a.json b.json --moves   # rename-aware compare
toolscan missing --from tools.txt     # which required tools are absent?
toolscan drift --baseline machine.json # CI-friendly machine drift check
```