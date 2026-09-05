# toolscan

![CI](https://github.com/Alot1z/toolscan/actions/workflows/ci.yml/badge.svg)
![license MIT](https://img.shields.io/badge/license-MIT-blue)
![node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

<p align="center">
  <img src="assets/logo.svg" alt="toolscan — radar-sweep mark" width="140" height="140">
</p>

> A radar sweep across everything a machine can run — not just what the shell
> happens to see on PATH.

**toolscan** is cross-platform tool discovery with a hard line on honesty. It
scans PATH, the XDG roots, and the common install locations where modern CLIs
actually land (~/.local/bin, ~/.npm-global, ~/.cargo/bin, %LOCALAPPDATA%\Programs,
and friends), then reports — bounded, truthful, JSON out. Every scan is capped;
a scan that hits its budget says so and never pretends to be complete.

```bash
toolscan                       # JSON scan of PATH + common roots (fast)
toolscan list                  # names only
toolscan check node            # resolved path; exit 0/1
toolscan snapshot --out m.json # baseline this machine
toolscan drift --baseline m.json   # CI-friendly machine drift check
```

## Who this is for

- **Agent harnesses** — which CLIs does this machine actually have, and where?
  Not just the shell PATH: the skills, MCP servers, and toolchains an agent may
  want live in half a dozen roots.
- **Skills / installer tools** — probe for what a setup script needs before it
  installs, and keep a per-machine baseline that tells you what changed.
- **MCP servers & language toolchains** — discover sibling tools and runtimes
  at launch without shelling out to a login shell.
- **CI drift checks** — a machine that must have node, uv, eslint, …:
  `toolscan missing --from required.txt` fails the build with the absent names.
  Long-lived runners can `drift` against a baseline so environment changes
  surface in CI instead of on a developer laptop.

Because output is one JSON document with documented exit codes, it composes
into scripts, dashboards, and other programs — a tiny discovery engine, not an
interactive shell.

## Why which is not enough

which/where only see the shell PATH. Harness CLIs, language toolchains, and
GUI-adjacent binaries routinely land outside it — ~/.local/bin, ~/.npm-global,
%LOCALAPPDATA%\Programs, ~/.cargo/bin and friends. toolscan scans those roots
too, first-hit-wins after PATH, and reports exactly what it saw.

## Bounded and truthful by construction

- **Bounded** — every scan is capped (max files, max depth, max ms). A scan
  that hits the budget reports truncated: true and exits 2. A partial scan is
  never presented as a complete one.
- **Fail closed** — check and missing refuse to answer from a truncated scan
  (exit 2 with a reason) instead of emitting a silent "not found"; scan audits
  its own output against the documented JSON shape before emitting it.
- **Read-only** — nothing is installed, modified, or executed. toolscan only
  looks.
- **toolscan doctor** verifies the whole surface on demand: schema, absolute
  paths that exist, honest truncation — the invariant oracle of a healthy
  install.

## Install

```bash
npm install -g toolscan          # or:
node dist/toolscan.mjs ...       # run the committed bundle directly, no install
```

dist/toolscan.mjs is a single committed zero-dependency file — consumers never
build and never install. Set TOOLSCAN_PATH=/path/to/dist/toolscan.mjs (or put
toolscan on PATH) and any script can spawn the exact artifact that CI tested.
That seam is how installers and harness probes integrate toolscan — see
docs/compatibility.md for the load-bearing JSON contract.

## Commands

| Command | What it does | Exit |
|---|---|---|
| scan (default) | JSON discovery of PATH + roots | 0 / 2 truncated |
| list | names only, one per line | 0 / 2 truncated |
| check <name> | print resolved path | 0 found / 1 not |
| snapshot [--out F] | persist a point-in-time scan | 0 / 2 truncated |
| diff A [B] | added / removed / changed (B = live scan) | 1 when anything changed |
| missing --from F | validate a name list | 1 when any absent |
| drift --baseline B | scan vs snapshot, rewrite baseline | 1 drifted / 2 truncated |
| doctor | one-shot invariant oracle over a live scan: schema, absolute paths on disk, honest truncation | 0 green / 1 violation / 2 truncated |

diff --moves detects renames by bounded content hash (only launchers ≤ 2 MB
are hashed). See docs/usage.md for flags and exit-code semantics.

## Development

```bash
npm install       # dev-only deps (typescript, effect, esbuild, vitest)
npm run typecheck
npm test          # builds dist/ first, then the hermetic vitest suite
```

Layout: src/ (Effect core), tests/ (hermetic — injected env, no real PATH),
docs/, resources/, scripts/. The committed dist/toolscan.mjs is the shipped
artifact — rebuild it in the same commit as any src/ change. The brand mark is
generated, not drawn by hand: scripts/render-logo.mjs emits the SVG + PNG
assets from a single geometry source (see CONTRIBUTING.md).

Want to help? Read CONTRIBUTING.md — the suite is hermetic and the bar is:
bounded, truthful, typed, tested.

## JSON contract

The scan shape is load-bearing for consumers — it is unchanged since v1.0.0
(see docs/compatibility.md).

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

## Documentation

- docs/usage.md — every command, flag, and exit code
- docs/architecture.md — pipeline, budget model, bundle strategy
- docs/compatibility.md — the load-bearing JSON contract and its consumers
- agents.md — condensed brief for AI agents working in this repo

## License

MIT — see LICENSE.
