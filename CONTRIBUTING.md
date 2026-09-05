# Contributing to toolscan

Thanks for wanting to help. toolscan's whole reason to exist is a hard line on
honesty — every scan bounded, every answer truthful, nothing fabricated — so
the contribution bar follows from that. Small, correct, well-tested changes
are very welcome.

## Ground rules

- **Bounded.** Every scan is capped (files, depth, ms). A scan that hits a
  budget reports `truncated: true` and exits 2. New scanning features must
  spend from the same shared budget — unbounded walks are rejected.
- **Truthful.** `elapsedMs`, `pathEntries`, `truncated` are always reported.
  Errors degrade to empty/absent, never to fabricated results. Never present a
  partial answer as complete.
- **Fail closed.** `check` and `missing` must refuse to answer from a truncated
  scan rather than emit a silent "not found". Output is audited against the
  documented JSON shape before it is emitted.
- **Read-only.** toolscan only looks. No installing, modifying, or executing
  discovered files.
- **Typed and tested.** The core is TypeScript + Effect; behavior is pinned by
  hermetic tests. A change without a test that would fail without it will be
  sent back.

## The JSON contract is load-bearing

`scan` output — `{ ok, elapsedMs, truncated, pathEntries, tools: [{name,
path, source}] }` with `source: "PATH" | "root"` and first-hit-wins ordering —
is consumed by external programs (see `docs/compatibility.md`). Any change to
that shape is breaking and must be versioned, never slipped in.

## Setting up

```bash
npm install       # dev-only deps (typescript, effect, esbuild, vitest)
npm run typecheck
npm test          # pretest rebuilds dist/, then the hermetic vitest suite
```

- Tests are hermetic: they inject `env`/`platform` into `scan()` and never
  touch the real PATH. Windows PATHEXT semantics are simulated with an
  injected `PATHEXT`; win32 mode is exercised on every host.
- The committed `dist/toolscan.mjs` is the shipped artifact. Any `src/` change
  must land with its rebuilt bundle in the same commit — CI enforces this with
  a byte-for-byte `dist`-sync gate.

## Brand assets are generated

The logo is not a hand-edited file. `scripts/render-logo.mjs` is the single
source of the mark (geometry + palette), and emits both the SVG and PNG
assets:

```bash
node scripts/render-logo.mjs          # writes assets/logo.svg, logo-banner.svg, logo-*.png
```

Change the geometry in the script, re-render, and commit script + assets
together. Never edit `assets/*` by hand.

## Committing

- Conventional Commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
  `chore:`, `ci:` — imperative subject, body only for the why.
- No AI/attribution footers (`Co-Authored-By`, "Generated with …"). The
  repo's `commit-msg` guard strips them; commits are authored by their human
  author.

## Questions

Open an issue. For a change touching the scan output shape, start a discussion
first — the contract is the one thing that cannot quietly change.
