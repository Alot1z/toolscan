---
name: toolscan
description: >-
  Use when an agent needs to discover what tools exist on this machine beyond
  the shell PATH — CLIs in ~/.local/bin, ~/.npm-global, ~/.cargo/bin,
  %LOCALAPPDATA%\Programs and friends — or must fail closed when a required
  tool is absent, a machine drifted from its baseline, or a scan was
  truncated. Bounded, truthful, JSON-first tool discovery for harness setup,
  skill installers, MCP servers, and CI drift gates.
version: 1.0.0
license: MIT
tags: [discovery, agents, ci, baseline, fail-closed, toolscan]
---

# toolscan — bounded tool discovery for agents

Discover what a machine can actually run — not just what the shell PATH
happens to see — and let every consumer of that answer fail closed.

## The one contract to internalize

**A truncated scan is not an answer.** Exit `2` means the budget was hit and
the result is partial. `check` and `missing` refuse to answer at all on a
truncated scan (a partial scan must never produce a silent "not found");
`drift` refuses to write a truncated scan as a baseline. Build on this: treat
exit `2` as "no verdict", never as "not found".

## Commands (the real surface)

```bash
toolscan                       # JSON scan of PATH + common roots
toolscan list                  # names only
toolscan check <name>          # resolved path on stdout; exit 0/1
toolscan snapshot --out m.json # baseline this machine
toolscan diff m.json           # added/removed/changed; exit 1 when anything
toolscan missing --from req.txt  # absent names; exit 1
toolscan drift --baseline m.json # scan+compare+rewrite; exit 1 drifted, 2 truncated
toolscan doctor                # invariant oracle over a live scan
```

Filtering: `--name GLOB`, `--roots A,B`, `--no-path`/`--no-roots` (hermetic),
`--depth N`, `--max-ms N`, `--max-files N`, `--format json|text`, `--moves`
(rename-aware diff), `--quiet`. Full semantics: `docs/usage.md` in the repo.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success; nothing changed / missing / truncated |
| `1` | a real difference: tool missing, drift, `check` miss, `doctor` violation |
| `2` | scan truncated (budget exceeded) — the answer is partial |

## Agent recipes

**Preflight before installing anything** (fail closed, no verdict on truncation):

```bash
toolscan missing --from required-tools.txt || [ $? = 1 ] && echo "missing tools: see names above"
```

**Baseline a golden machine, then gate CI on drift:**

```bash
toolscan snapshot --out golden.json
toolscan drift --baseline golden.json   # exit 1 = environment changed
```

**Find where a CLI actually lives** (PATH or any common root):

```bash
p=$(toolscan check rg) && echo "rg at $p"
```

**Compose with skill installers** — the live upstream case is the Ix repo's
`scripts/install-skill.sh`: when `TOOLSCAN_PATH` points at a toolscan binary,
the installer feeds its discovery into the harness probe so install roots
beyond PATH are found too; unset (the default), the embedded PATH probe
decides and behavior is identical on a clean machine. The pattern: discovery
is *opt-in enrichment* on top of a self-sufficient default, never a hard
dependency.

## Honesty rules this skill inherits

- Every scan is time- and file-budgeted; a scan that hits its budget says so
  (exit `2`) and never pretends to be complete.
- Output is one JSON document (or documented text lines) — no prose padding,
  so scripts and agents can consume it directly.
- `doctor` exists to prove the contract, not to assert health: run it against
  a live scan and it reports schema violations, non-existent absolute paths,
  and unreported truncation.
