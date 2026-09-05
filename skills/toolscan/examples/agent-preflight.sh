#!/usr/bin/env bash
# Example: an agent bootstrap that fails closed before doing work.
# Not executed by CI; copy into your own harness setup.
set -euo pipefail
NEEDED=(node git rg)
REQ="$(mktemp)"; trap 'rm -f "$REQ"' EXIT
printf '%s\n' "${NEEDED[@]}" > "$REQ"

toolscan missing --from "$REQ"; rc=$?
case $rc in
  0) echo "preflight ok: ${NEEDED[*]}" ;;
  1) echo "preflight failed: missing tools listed above" >&2; exit 1 ;;
  2) echo "preflight inconclusive: scan truncated (exit 2) — refusing to guess" >&2; exit 1 ;;
  *) echo "preflight failed: toolscan exit $rc" >&2; exit 1 ;;
esac
