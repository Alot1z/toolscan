# toolscan — agent brief

Cross-platform tool discovery: PATH + XDG + common install roots. Bounded,
truthful, JSON out. TypeScript + Effect core, **zero-dependency runtime
bundle** (`dist/toolscan.mjs`) that `node` can spawn directly — consumers
never build and never install.

## Identity (do not break these)

1. **Bounded**: every scan is capped (max files, max depth, max ms). A scan
   that hits the budget reports `truncated: true` and exits 2 — a partial scan
   is never presented as complete.
2. **Truthful**: `elapsedMs`, `pathEntries`, `truncated` are always reported.
   Errors degrade to empty/absent, never to fabricated results.
3. **The JSON contract is load-bearing**: `scan` output is
   `{ ok, elapsedMs, truncated, pathEntries, tools: [{name, path, source}] }`
   with `source: "PATH" | "root"` and first-hit-wins ordering. Ix
   (`ix mcp install`, `install-skill.sh`) consumes exactly this shape via
   `TOOLSCAN_PATH` — see `docs/compatibility.md`. Any output-shape change is a
   breaking change for the seam and must be versioned.
4. **Zero-dep at runtime**: the committed `dist/toolscan.mjs` bundle is the
   artifact. TypeScript + Effect are build-time only.

## Structure

```
src/            TypeScript + Effect core (scan pipeline, snapshot/diff, CLI)
tests/          vitest, hermetic (injected env/fixture dirs — no real PATH)
docs/           usage, architecture, compatibility (the Ix contract)
resources/      example snapshots and fixtures
scripts/        build.mjs (esbuild bundle with shebang)
dist/           COMMITTED zero-dep bundle (rebuild on change, keep in sync)
agents.md       this file
```

## Build / test / commit

```bash
npm run build      # esbuild -> dist/toolscan.mjs (committed)
npm run typecheck  # tsc --noEmit
npm test           # build + vitest (pretest builds, so dist is always fresh)
```

Commit conventions: conventional commits, author `Alot1z`, no AI/attribution
footers (the repo's `commit-msg` guard strips them). Rebuild `dist/` in the
same commit as any `src/` change — the committed bundle is the shipped
artifact.

## Testing discipline

- Unit tests inject `env`/`platform` directly into `scan()` — hermetic on any
  host (Windows PATHEXT semantics are simulated with an injected `PATHEXT`).
- CLI tests spawn the real `dist/toolscan.mjs` with a pinned environment.
  Windows note: the OS re-injects the parent's `ProgramFiles` into spawned
  children whatever `env` says, so CLI tests use `--no-roots` and root-scan
  coverage lives in the in-process tests.
- `--moves` move detection hashes only launchers ≤ 2 MB (`MOVE_HASH_MAX_BYTES`).