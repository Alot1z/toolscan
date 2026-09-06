# Composing toolscan into real systems

Three proven integration shapes. All of them share one rule: the integrator
degrades gracefully when toolscan is absent, and treats exit 2 as "no verdict"
(fail closed), never as "not found".

## 1. Opt-in enrichment for installers (the Ix live case)

`ix-infrastructure/Ix` — `scripts/install-skill.sh` decides harness presence
with an embedded PATH probe. When the user exports `TOOLSCAN_PATH`, the
installer additionally consults toolscan's discovery so harness CLIs installed
outside PATH (common on Windows and npm-global setups) are found too.

- Opt-in by explicit env var: the script never executes a bare `toolscan` from
  PATH — an attacker-named binary must not be able to inject itself into an
  installer's decisions.
- Additive only: unset, behavior is byte-identical to the embedded probe.
- Same shape fits any installer: probe self-sufficiently, enrich when the
  operator opts in, and record which mechanism decided (`detectedVia`).

## 2. CI drift gate on long-lived runners

```yaml
- name: Machine drifted?
  run: |
    toolscan drift --baseline .ci/machine.json
    # exit 0 = unchanged; 1 = drift (fail the build); 2 = truncated (no verdict — fail too)
    [ $? = 0 ] || { echo "::error::machine state changed or scan truncated"; exit 1; }
```

`drift` refuses to write a truncated scan as the new baseline, so a slow
runner cannot quietly narrow what the baseline covers.

## 3. Required-tool preflight for setup scripts

```bash
toolscan missing --from required.txt
case $? in
  0) echo "all required tools present" ;;
  1) echo "install the missing tools above"; exit 1 ;;
  2) echo "scan truncated — cannot answer honestly"; exit 1 ;;
esac
```

`check`/`missing` refuse to answer on a truncated scan: a partial scan never
produces a silent "not found".
