# toolscan — architecture

## Pipeline

```
cli.ts (argv -> command) -> scan.ts (Effect pipeline) -> report -> stdout/exit
                              |-> snapshot.ts (persist / diff / drift)
```

`src/scan.ts` is the core. One scan = PATH pass + roots pass, both bounded by a
**shared budget**:

- `maxFiles` — total directory entries examined (files AND directories), shared
  across the parallel roots scans
- `maxDepth` — how deep the roots walk goes
- `maxMs` — wall-clock budget; the PATH pass checks it per entry, and the roots
  pass is skipped entirely if it is already spent

The budget lives in an Effect `Ref<{ files, truncated }>`; the roots scan runs
with `Effect.forEach(..., { concurrency: "unbounded" })`, so every root walks
in parallel but spends from the same counter. Results merge in root order with
first-hit-wins, so output is deterministic.

## First-hit-wins

PATH entries are scanned in order and the first executable wins the name.
Roots only fill names PATH did not provide. Order in the report is alphabetical
by name; order of resolution is PATH-then-roots, earlier-then-later.

## Bounded truthfulness

- A budget hit sets `truncated: true` and stops all further work. The report
  says so, and the exit code is 2. `drift` additionally refuses to write a
  truncated scan over the baseline — a partial scan must never poison future
  comparisons.
- Non-executable detection is platform-correct: on Windows, PATHEXT extension
  membership (injectable); elsewhere, `X_OK` access.
- Root walking skips `SKIP_NAMES` (`.git`, `node_modules`, caches, temp dirs)
  and never follows symlinked directories.

## Effect usage (why here, not everywhere)

Effect earns its keep in exactly three places:

1. **Shared mutable budget across concurrent scans** — the `Ref` is the single
   owner of `files`/`truncated`, so parallel roots cannot race the counter.
2. **Typed pipeline** — `scan()` is `Effect<ScanReport, never, never>`: the
   CLI cannot accidentally treat a failure as data, and all degrade paths are
   explicit.
3. **Injected environment** — `env`/`platform` are parameters, so the whole
   scanner is hermetic in tests without a process boundary.

Everything else (argv parsing, snapshot IO, formatting) is deliberately plain —
Effect's Command layer and service layers would add weight without adding
boundedness or truthfulness.

## Move detection (`--moves`)

`diff`/`drift` with `--moves` detects renames: an added name and a removed
name whose launcher files hash identically (sha256). Hashing is **bounded**:
only files ≤ `MOVE_HASH_MAX_BYTES` (2 MB) are read — a 100 MB runtime is
never touched, so the check stays cheap on real machines.

## Bundle strategy

`scripts/build.mjs` bundles `src/cli.ts` (TypeScript + Effect) with esbuild to
`dist/toolscan.mjs` — a single, committed, zero-dependency ESM file with a
shebang. Consumers (`node dist/toolscan.mjs`, or `TOOLSCAN_PATH` pointing at
it) never install or build. The bundle is ~500 KB (Effect's runtime); the
trade-off is accepted because the artifact is committed once and the source
gains typed, testable composition.