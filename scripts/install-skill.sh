#!/usr/bin/env bash
#
# Install toolscan: the agent skill, the CLI, or both, for every agent harness
# found on this machine.
#
# The skill package (skills/toolscan) is a single harness-agnostic skill. Each
# agent harness loads skills from its own directory; this script probes the
# four verified conventions (claude, agents, codex, cursor — the same paths
# ix-cli/scripts/skill-harnesses.mjs verifies for the Ix repo) and deploys to
# each that is present.
#
# The CLI is optional (--with-cli): installing it copies dist/toolscan.mjs to
# ~/.local/bin/toolscan (created if needed). Pass --with-cli only when you want
# the binary on this machine; the skill works without it by pointing
# TOOLSCAN_PATH at any toolscan checkout.
#
# Refusal guard: a destination that already exists and is NOT a previous
# toolscan install is never overwritten without --force — a silent rm -rf of a
# hand-written skill that happened to share the name is exactly the class of
# destruction an installer must not do quietly.
#
# Usage:
#   bash scripts/install-skill.sh            # install the skill everywhere
#   bash scripts/install-skill.sh --dry-run  # show the targets, write nothing
#   bash scripts/install-skill.sh --force    # overwrite a same-name foreign skill
#   bash scripts/install-skill.sh claude codex  # explicit harness ids only
#   bash scripts/install-skill.sh --with-cli # also install the CLI launcher
#   bash scripts/install-skill.sh --dry-run --json  # machine-readable report

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/skills/toolscan"
[ -f "$SRC/SKILL.md" ] || { echo "error: $SRC/SKILL.md not found" >&2; exit 1; }

# The four verified harness conventions (id|label|bin|config-dir|skill-dir).
# Verified against the harnesses' actual conventions in the Ix repo
# (ix-cli/scripts/skill-harnesses.mjs); keep the two registries in sync.
REGISTRY=(
  "claude|Claude Code|claude|$HOME/.claude|$HOME/.claude/skills"
  "agents|Agents (agents.md)||$HOME/.agents|$HOME/.agents/skills"
  "codex|Codex|codex|$HOME/.codex|$HOME/.codex/skills"
  "cursor|Cursor|cursor|$HOME/.cursor|$HOME/.cursor/skills-cursor"
)

FORCE=0 DRY_RUN=0 JSON=0 HELP=0 WITH_CLI=0
EXPLICIT=()
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --json) JSON=1 ;;
    --with-cli) WITH_CLI=1 ;;
    --help|-h) HELP=1 ;;
    -*) echo "error: unknown option $arg" >&2
        echo "       try: bash scripts/install-skill.sh --help" >&2
        exit 1 ;;
    *) EXPLICIT+=("$arg") ;;
  esac
done

if [ "$HELP" = "1" ]; then
  cat <<'USAGE'
Install the toolscan agent skill (and optionally the CLI) for every agent
harness found on this machine.

Usage:
  bash scripts/install-skill.sh            # install the skill everywhere
  bash scripts/install-skill.sh --dry-run  # show the targets, write nothing
  bash scripts/install-skill.sh --force    # overwrite a same-name foreign skill
  bash scripts/install-skill.sh claude codex  # explicit harness ids only
  bash scripts/install-skill.sh --with-cli # also install the CLI launcher
  bash scripts/install-skill.sh --dry-run --json  # machine-readable report

Valid harness ids: claude agents codex cursor
USAGE
  exit 0
fi

# --- Selection ----------------------------------------------------------------
ids=() labels=() bins=() dests=() present=() vias=()
for row in "${REGISTRY[@]}"; do
  IFS='|' read -r id label bin cfg skill <<<"$row"
  p=0 via=none
  if [ -n "$bin" ] && command -v "$bin" >/dev/null 2>&1; then p=1 via=path
  elif [ -d "$cfg" ]; then p=1 via=config-dir; fi
  ids+=("$id") labels+=("$label") bins+=("$bin") dests+=("$skill/toolscan")
  present+=("$p") vias+=("$via")
done

if [ "${#EXPLICIT[@]}" -gt 0 ]; then
  all="${ids[*]}"
  for id in "${EXPLICIT[@]}"; do
    case " $all " in
      *" $id "*) ;;
      *) echo "error: unknown harness id '$id'" >&2
         echo "       valid ids: $all" >&2
         exit 1 ;;
    esac
  done
  want=" ${EXPLICIT[*]} "
  o_ids=("${ids[@]}"); o_dests=("${dests[@]}"); o_present=("${present[@]}"); o_vias=("${vias[@]}")
  ids=(); dests=(); present=(); vias=()
  for i in "${!o_ids[@]}"; do
    case "$want" in
      *" ${o_ids[$i]} "*) ids+=("${o_ids[$i]}"); dests+=("${o_dests[$i]}"); present+=("${o_present[$i]}"); vias+=("${o_vias[$i]}") ;;
    esac
  done
fi

# --- Install loop -------------------------------------------------------------
say() { [ "$JSON" = "1" ] || echo "$@"; }
installed=0 conflicts=0
DECISIONS=()
for i in "${!ids[@]}"; do
  id="${ids[$i]}"; dest="${dests[$i]}"; p="${present[$i]}"; via="${vias[$i]}"
  if [ "$p" != "1" ]; then
    say "skip [$id] — harness not present (no CLI, no config dir)"
    DECISIONS+=("$id"$'\t'"skip"$'\t'""$'\t'"$via")
    continue
  fi
  if [ -e "$dest" ] && [ "$FORCE" != "1" ] && ! grep -qs '^name: toolscan$' "$dest/SKILL.md"; then
    if [ "$DRY_RUN" = "1" ]; then
      say "would refuse [$id]: $dest — exists and is not a toolscan install (use --force)"
      DECISIONS+=("$id"$'\t'"would-refuse"$'\t'"$dest"$'\t'"$via")
    else
      echo "error: $dest exists and is not a toolscan install." >&2
      echo "       Move it aside, or re-run with --force to overwrite it." >&2
      DECISIONS+=("$id"$'\t'"refused"$'\t'"$dest"$'\t'"$via")
    fi
    conflicts=$((conflicts + 1))
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would install [$id]: $dest"
    DECISIONS+=("$id"$'\t'"would-install"$'\t'"$dest"$'\t'"$via")
  else
    mkdir -p "$(dirname "$dest")"
    [ -e "$dest" ] && rm -rf "$dest"
    cp -R "$SRC" "$dest"
    say "Installed [$id]: $dest"
    DECISIONS+=("$id"$'\t'"installed"$'\t'"$dest"$'\t'"$via")
  fi
  installed=$((installed + 1))
done

# --- Optional CLI -------------------------------------------------------------
CLI_DEST="${HOME}/.local/bin/toolscan"
if [ "$WITH_CLI" = "1" ] && [ -f "$ROOT/dist/toolscan.mjs" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "would install [cli]: $CLI_DEST"
  else
    mkdir -p "$(dirname "$CLI_DEST")"
    cp "$ROOT/dist/toolscan.mjs" "$CLI_DEST"
    chmod +x "$CLI_DEST" 2>/dev/null || true
    say "Installed [cli]: $CLI_DEST"
  fi
  installed=$((installed + 1))
fi

# --- Report -------------------------------------------------------------------
if [ "$JSON" = "1" ]; then
  printf '%s\n' "${DECISIONS[@]:-}" | TOOLSCAN_DRY_RUN="$DRY_RUN" node -e '
    const lines = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
    const hosts = lines.map((line) => {
      const [id, action, dest, via] = line.split("\t");
      return { id, action, dest: dest || null, detectedVia: via };
    });
    process.stdout.write(JSON.stringify({ dryRun: process.env.TOOLSCAN_DRY_RUN === "1", hosts }, null, 2) + "\n");
  '
  [ "$conflicts" = "0" ] || exit 1
  exit 0
fi

echo
if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run: $installed target(s) would be installed."
  echo "Add --json for a machine-readable report."
  [ "$conflicts" = "0" ] || exit 1
  exit 0
fi
[ "$conflicts" = "0" ] || echo "$conflicts destination(s) refused (foreign skill protected; use --force to override)."
echo "Restart the agent harness so it picks up the toolscan skill."
# The preview and the real run must agree: a would-refuse in a dry run exits 1,
# so a conflict in the real run exits 1 too (same contract as the Ix installer).
[ "$conflicts" = "0" ] || exit 1
