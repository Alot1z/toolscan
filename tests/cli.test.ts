import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DIST = resolve("dist/toolscan.mjs");

let root: string;
let binA: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toolscan-cli-"));
  binA = join(root, "binA");
  home = join(root, "home");
  mkdirSync(binA, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A hermetic Windows-ish environment for the spawned CLI. Every root that
 * defaultRoots() reads is pinned to a non-existent path under the temp root
 * so a leak from the parent environment (e.g. ProgramFiles(x86)) can never
 * pull the real system into the scan.
 */
function env(): Record<string, string> {
  return {
    PATH: binA,
    PATHEXT: ".CMD;.EXE",
    USERPROFILE: home,
    HOME: join(root, "home2"),
    LOCALAPPDATA: join(root, "localappdata"),
    APPDATA: join(root, "appdata"),
    ProgramFiles: join(root, "pf"),
    "ProgramFiles(x86)": join(root, "pf86"),
    XDG_BIN_HOME: join(root, "xdg-bin"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_DIRS: join(root, "xdg-dirs"),
  };
}

function cli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [DIST, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env(), ...extraEnv },
  });
}

describe("toolscan CLI", () => {
  it("prints the version", () => {
    const r = cli(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("toolscan 2.0.0");
  });

  it("scans to the v1 JSON contract", () => {
    writeFileSync(join(binA, "tool1.cmd"), "x");

    // --no-roots keeps the spawn hermetic: Windows re-injects the parent's
    // ProgramFiles into children whatever the env says, so the roots scan
    // cannot be scrubbed at the process boundary (covered in-process instead).
    const r = cli(["--no-roots"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(typeof out.elapsedMs).toBe("number");
    expect(out.truncated).toBe(false);
    expect(out.pathEntries).toBe(1);
    expect(out.tools).toEqual([{ name: "tool1", path: join(binA, "tool1.cmd"), source: "PATH" }]);
  });

  it("emits tab-separated text with --format text", () => {
    writeFileSync(join(binA, "tool1.cmd"), "x");

    const r = cli(["--format", "text", "--no-roots"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`tool1\t${join(binA, "tool1.cmd")}\tPATH`);
  });

  it("check prints the resolved path (exit 0) and misses cleanly (exit 1)", () => {
    writeFileSync(join(binA, "tool1.cmd"), "x");

    const hit = cli(["check", "tool1"]);
    expect(hit.status).toBe(0);
    expect(hit.stdout.trim()).toBe(join(binA, "tool1.cmd"));

    const miss = cli(["check", "no-such-tool"]);
    expect(miss.status).toBe(1);
    expect(miss.stderr).toContain("not found: no-such-tool");
  });

  it("list prints names only", () => {
    writeFileSync(join(binA, "a.cmd"), "x");
    writeFileSync(join(binA, "b.cmd"), "x");

    const r = cli(["list", "--no-roots"]);
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean).sort()).toEqual(["a", "b"]);
  });

  it("missing reports absent names and exits 1", () => {
    writeFileSync(join(binA, "a.cmd"), "x");
    const list = join(root, "tools.txt");
    writeFileSync(list, "a\nb,c\n");

    const r = cli(["missing", "--from", list, "--no-roots"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, missing: ["b", "c"] });
  });

  it("snapshot + diff: identical scans agree, a removed tool drifts", () => {
    writeFileSync(join(binA, "a.cmd"), "x");
    const base = join(root, "base.json");

    expect(cli(["snapshot", "--out", base, "--no-roots"]).status).toBe(0);
    expect(existsSync(base)).toBe(true);
    expect(cli(["diff", base, "--no-roots"]).status).toBe(0);

    // Remove a and add b: diff must exit 1 naming both.
    rmSync(join(binA, "a.cmd"));
    writeFileSync(join(binA, "b.cmd"), "x");
    const diff = cli(["diff", base, "--no-roots"]);
    expect(diff.status).toBe(1);
    const out = JSON.parse(diff.stdout);
    expect(out.removed.map((x: { name: string }) => x.name)).toEqual(["a"]);
    expect(out.added.map((x: { name: string }) => x.name)).toEqual(["b"]);
  });

  it("drift rewrites the baseline and exits 1 when the machine changed", () => {
    writeFileSync(join(binA, "a.cmd"), "x");
    const base = join(root, "base.json");
    cli(["snapshot", "--out", base, "--no-roots"]);

    // Same state -> no drift, baseline rewritten (timestamp advances).
    expect(cli(["drift", "--baseline", base, "--no-roots"]).status).toBe(0);

    writeFileSync(join(binA, "b.cmd"), "x");
    const drift = cli(["drift", "--baseline", base, "--no-roots"]);
    expect(drift.status).toBe(1);
    expect(JSON.parse(drift.stdout).added.map((x: { name: string }) => x.name)).toEqual(["b"]);

    // The rewritten baseline now contains b: a re-run is clean again.
    expect(cli(["drift", "--baseline", base, "--no-roots"]).status).toBe(0);
  });

  it("fail-closed: truncated check/missing exit 2 with a reason, never a silent negative", () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(binA, `t${i}.cmd`), "x");

    // Without truncation, check misses cleanly with exit 1.
    const cleanMiss = cli(["check", "absent", "--no-roots", "--max-files", "100"]);
    expect(cleanMiss.status).toBe(1);
    expect(cleanMiss.stdout.trim()).toBe("");

    // With a forced budget, the same miss must REFUSE to answer: exit 2,
    // reason on stderr, stdout empty (a parser sees nothing to trust).
    const truncatedMiss = cli(["check", "t0", "--no-roots", "--max-files", "2"]);
    expect(truncatedMiss.status).toBe(2);
    expect(truncatedMiss.stderr).toMatch(/truncated/);
    expect(truncatedMiss.stdout.trim()).toBe("");

    const nameList = join(root, "tools.txt");
    writeFileSync(nameList, "t0\nabsent\n");
    const truncatedMissing = cli(["missing", "--from", nameList, "--no-roots", "--max-files", "2"]);
    expect(truncatedMissing.status).toBe(2);
    expect(truncatedMissing.stderr).toMatch(/truncated/);
  });

  it("fail-closed: scan output must conform to the documented schema before emission", () => {
    writeFileSync(join(binA, "tool1.cmd"), "x");
    const r = cli(["scan", "--no-roots"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    // The audit gate ran inside the CLI: shape is exactly the documented one.
    expect(Object.keys(out).sort()).toEqual(["elapsedMs", "ok", "pathEntries", "tools", "truncated"]);
    expect(out.tools[0]).toEqual({ name: "tool1", path: join(binA, "tool1.cmd"), source: "PATH" });
  });

  it("doctor is ALL GREEN on a healthy machine surface and reports truncation as exit 2", () => {
    writeFileSync(join(binA, "tool1.cmd"), "x");

    const ok = cli(["doctor", "--no-roots"]);
    expect(ok.status).toBe(0);
    const report = JSON.parse(ok.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c: { name: string }) => c.name)).toEqual(["schema", "paths-exist", "complete-scan"]);

    // Enough files to actually exhaust a --max-files 2 budget.
    for (let i = 0; i < 5; i++) writeFileSync(join(binA, `t${i}.cmd`), "x");
    const truncated = cli(["doctor", "--no-roots", "--max-files", "2"]);
    expect(truncated.status).toBe(2);
    expect(JSON.parse(truncated.stdout).truncated).toBe(true);
  });

  it("drift refuses to overwrite the baseline from a truncated scan (exit 2)", () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(binA, `t${i}.cmd`), "x");
    const base = join(root, "base.json");
    cli(["snapshot", "--out", base, "--no-roots"]);

    // A budget that runs out mid-directory forces truncation.
    const r = cli(["drift", "--baseline", base, "--no-roots", "--max-files", "2"]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).truncated).toBe(true);

    // Baseline untouched: still the original five-tool snapshot.
    const after = JSON.parse(readFileSync(base, "utf8"));
    expect(after.tools.map((t: { name: string }) => t.name).sort()).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });
});