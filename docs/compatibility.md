# toolscan — compatibility & the JSON contract

## The load-bearing contract (v1, unchanged in v2)

The bare scan is the shape external consumers parse. **It must not change.**

```json
{
  "ok": true,
  "elapsedMs": 184,
  "truncated": false,
  "pathEntries": 34,
  "tools": [
    { "name": "claude", "path": "E:\\npm-global\\claude.cmd", "source": "PATH" },
    { "name": "uv", "path": "C:\\Users\\me\\.local\\bin\\uv.exe", "source": "root" }
  ]
}
```

Contract rules:

- `tools` is sorted by name; `source` is `"PATH"` or `"root"`.
- `truncated: true` (and exit 2) means the scan hit its budget — treat the
  result as partial, never as the complete machine.
- `check <name>` prints the resolved path and exits 0/1; `missing --from`
  emits `{ ok, missing }` and exits 1 when anything is absent.

## How consumers integrate

The seam is `TOOLSCAN_PATH=/path/to/dist/toolscan.mjs` (or `toolscan` on
PATH): a consumer spawns the committed bundle and parses the JSON above.
The seam is **purely additive** — a missing or failing toolscan never breaks
the consumer; a name found means "present", a name absent means "run the
embedded fallback probe". Integration semantics live in each consumer; this
repo's job is to keep the shape stable.

Known production consumers today: an installer and harness-detection step
that probes which agent CLIs are present before deploying skills to them
(`ix mcp install` / `install-skill.sh` in the Ix project; the `TOOLSCAN_PATH`
contract is also exercised by a merged harness-discovery parser).

## Version history

| Version | Change | Contract impact |
|---|---|---|
| 1.0.0 | initial scanner (zero-dep `.mjs`) | contract defined |
| 1.1.0 | `snapshot`, `diff`, `check`, `missing` | additive — scan shape unchanged |
| 2.0.0 | TypeScript + Effect core, repo restructure (`src/ tests/ docs/ resources/ agents.md`), committed `dist/` bundle; new: `drift`, `--moves`, `--no-roots`, `--format text` | scan shape unchanged; `diff` gains a `moved` array (additive); snapshot format stays `toolscan-snapshot/1` |
| 2.1.0 | brand pass: `assets/` generated logo (`scripts/render-logo.mjs`), README/CONTRIBUTING rewrite | none — docs, metadata, and assets only |

## Consumers must know

- `diff` now returns `moved: []` in every response (previously absent) —
  additive, so old parsers that ignore unknown keys are unaffected.
- `drift` exit codes: `0` unchanged, `1` drifted, `2` truncated (new) —
  truncated means the comparison is not trustworthy and the baseline was NOT
  rewritten.
- The committed artifact moved from `toolscan.mjs` (repo root) to
  `dist/toolscan.mjs`. `TOOLSCAN_PATH` must point at the new path after
  upgrading.
