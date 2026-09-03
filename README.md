# toolscan

Cross-platform tool discovery: **PATH + XDG + common install roots**. Bounded,
truthful, JSON out. TypeScript + Effect core, zero-dependency runtime bundle.

```bash
toolscan                       # JSON scan of PATH + common roots (fast)
toolscan list                  # names only
toolscan check node            # resolved path; exit 0/1
toolscan snapshot --out m.json # baseline this machine
toolscan diff m.json           # what changed since? exit 1 when anything
toolscan drift --baseline m.json  # CI-friendly machine drift check
```

## Why

`which`/`where` only see the shell PATH. Harness CLIs, language toolchains and
GUI-adjacent binaries routinely land outside it — `~/.local/bin`,
`~/.npm-global`, `%LOCALAPPDATA%\Programs`, `~/.cargo/bin` and friends.
toolscan scans those roots too, first-hit-wins after PATH, and reports exactly
what it saw.

It is **bounded and truthful by construction**: every scan is capped (max
files, max depth, max ms) and a scan that hits the budget says
`truncated: true` and exits 2 — a partial scan is never presented as a
complete one. Nothing is installed, modified, or executed; it is a read-only
scanner.

## Install

```bash
npm install -g toolscan          # or:
node dist/toolscan.mjs ...       # run the committed bundle directly, no install
```

`dist/toolscan.mjs` is a single committed zero-dependency file — consumers
never build. `TOOLSCAN_PATH=/path/to/dist/toolscan.mjs` (or `toolscan` on
PATH) is how Ix's `ix mcp install` / `install-skill.sh` power their harness
detection; the seam is purely additive, so a missing toolscan never breaks
anything.

## Commands

| Command | What it does | Exit |
|---|---|---|
| `scan` (default) | JSON discovery of PATH + roots | 0 / 2 truncated |
| `list` | names only, one per line | 0 / 2 truncated |
| `check <name>` | print resolved path | 0 found / 1 not |
| `snapshot [--out F]` | persist a point-in-time scan | 0 / 2 truncated |
| `diff A [B]` | added / removed / changed (B = live scan) | 1 when anything changed |
| `missing --from F` | validate a name list | 1 when any absent |
| `drift --baseline B` | scan vs snapshot, rewrite baseline | 1 drifted / 2 truncated |

`diff --moves` detects renames by bounded content hash (only launchers ≤ 2 MB
are hashed). See [docs/usage.md](docs/usage.md) for flags and exit-code
semantics.

## Development

```bash
npm install       # dev-only deps (typescript, effect, esbuild, vitest)
npm run typecheck
npm test          # builds dist/ first, then the hermetic vitest suite
```

Layout: `src/` (Effect core), `tests/` (hermetic — injected env, no real
PATH), `docs/`, `resources/`, `scripts/build.mjs` (esbuild bundle). The
committed `dist/toolscan.mjs` is the shipped artifact — rebuild it in the same
commit as any `src/` change. See [agents.md](agents.md) (agent brief) and
[docs/architecture.md](docs/architecture.md) (pipeline, budget model, bundle
strategy).

## JSON contract

The `scan` shape is load-bearing for consumers (Ix's `TOOLSCAN_PATH` seam);
it is unchanged since v1.0.0 — see [docs/compatibility.md](docs/compatibility.md).

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

## License

MIT