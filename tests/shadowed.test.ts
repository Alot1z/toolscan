// Hermetic tests for src/shadowed.ts — temp-dir fixtures, injected env,
// provider scopes are pure functions, so this runs on ANY host OS.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { shadowedNames } from "../src/shadowed.js";
import type { ScanReport } from "../src/scan.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toolscan-shadowed-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const winEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  USERPROFILE: "C:\\Users\\t",
  ProgramFiles: "C:\\Program Files",
  ...extra,
});

const baseReport = (): ScanReport => ({
  ok: true,
  elapsedMs: 0,
  truncated: false,
  pathEntries: 0,
  tools: [],
});

describe("shadowedNames", () => {
  it("detects a name present in two PATH dirs with different targets (happy path)", () => {
    const binA = join(root, "binA");
    const binB = join(root, "binB");
    mkdirSync(binA);
    mkdirSync(binB);
    writeFileSync(join(binA, "dup.cmd"), "x");
    writeFileSync(join(binB, "dup.cmd"), "x");

    const out = shadowedNames(baseReport(), "win32", winEnv({ PATH: `${binA};${binB}` }));

    expect(out.ok).toBe(false);
    expect(out.shadowed).toHaveLength(1);
    expect(out.shadowed[0].name).toBe("dup");
    expect(out.shadowed[0].hits).toHaveLength(2);
    expect(out.shadowed[0].hits.map((h) => h.path).sort()).toEqual([join(binA, "dup.cmd"), join(binB, "dup.cmd")].sort());
  });

  it("reports clean when every name is unique (negative path)", () => {
    const binA = join(root, "binA");
    const binB = join(root, "binB");
    mkdirSync(binA);
    mkdirSync(binB);
    writeFileSync(join(binA, "alpha.cmd"), "x");
    writeFileSync(join(binB, "beta.cmd"), "x");

    const out = shadowedNames(baseReport(), "win32", winEnv({ PATH: `${binA};${binB}` }));

    expect(out.ok).toBe(true);
    expect(out.shadowed).toEqual([]);
    expect(out.checked).toBe(2);
  });

  it("ignores the same target reachable twice (dedup by distinct path)", () => {
    const binA = join(root, "binA");
    mkdirSync(binA);
    writeFileSync(join(binA, "same.cmd"), "x");

    const out = shadowedNames(baseReport(), "win32", winEnv({ PATH: `${binA};${binA}` }));

    expect(out.ok).toBe(true);
    expect(out.shadowed).toEqual([]);
  });

  it("classifies machine vs user scope on win32 (dual-profile ghost shape)", () => {
    // Program Files cannot be mkdir'ed in a hermetic run — the provider's
    // MACHINE_PREFIXES check is prefix-based, so a fake root under a fake
    // Windows prefix exercises the same classification without privilege.
    const machineDir = join(root, "w", "Windows", "shim");
    const userDir = join(root, "w", "Users", "t", "AppData", "shim");
    mkdirSync(machineDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(machineDir, "ghost.exe"), "x");
    writeFileSync(join(userDir, "ghost.exe"), "x");

    const env: Record<string, string> = {
      ...winEnv(),
      ProgramFiles: join(root, "w", "Program Files"),
      USERPROFILE: join(root, "w", "Users", "t"),
      SystemRoot: join(root, "w", "Windows"),
      PATH: `${machineDir};${userDir}`,
    };
    const out = shadowedNames(baseReport(), "win32", env);

    expect(out.ok).toBe(false);
    expect(out.shadowed[0].name).toBe("ghost");
    const scopes = out.shadowed[0].hits.map((h) => h.scope).sort();
    expect(scopes).toEqual(["machine", "user"]);
  });

  it("is case-insensitive on win32 (Dup.cmd vs dup.exe)", () => {
    const binA = join(root, "binA");
    const binB = join(root, "binB");
    mkdirSync(binA);
    mkdirSync(binB);
    writeFileSync(join(binA, "Dup.cmd"), "x");
    writeFileSync(join(binB, "dup.exe"), "x");

    const out = shadowedNames(baseReport(), "win32", winEnv({ PATH: `${binA};${binB}` }));

    expect(out.ok).toBe(false);
    expect(out.shadowed[0].name).toBe("dup");
  });

  it("skips non-executables and unreadable dirs (no false positives)", () => {
    const binA = join(root, "binA");
    const binB = join(root, "binB");
    mkdirSync(binA);
    mkdirSync(binB);
    writeFileSync(join(binA, "dup.cmd"), "x");
    writeFileSync(join(binB, "dup.txt"), "x"); // not executable on win32
    const out = shadowedNames(baseReport(), "win32", winEnv({ PATH: `${binA};${binB};${join(root, "does-not-exist")}` }));
    expect(out.ok).toBe(true);
  });

  it("expands tokenized PATH entries before walking (win32 %VAR%)", () => {
    const binA = join(root, "binA");
    const binB = join(root, "binB");
    mkdirSync(binA);
    mkdirSync(binB);
    writeFileSync(join(binA, "tok.cmd"), "x");
    writeFileSync(join(binB, "tok.cmd"), "x");

    const out = shadowedNames(
      baseReport(),
      "win32",
      winEnv({ PATH: `${binA};%SHADOW_ROOT%\\binB`, SHADOW_ROOT: root }),
    );

    expect(out.ok).toBe(false);
    expect(out.shadowed[0].name).toBe("tok");
    expect(out.shadowed[0].hits.some((h) => h.path === join(binB, "tok.cmd"))).toBe(true);
  });

});

// Native POSIX semantics (X_OK bit, ':' separator vs drive-letter colons)
// are only assertable on a real POSIX host — same convention as scan.test.ts;
// the ubuntu CI leg runs these.
const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("shadowedNames — native POSIX semantics ($HOME scope, : separator, X_OK)", () => {
  it("classifies a $HOME-shadowed name as user scope on both hits", () => {
    const home = mkdtempSync(join(tmpdir(), "toolscan-shadowed-posix-"));
    const binA = join(home, "binA");
    const binB = join(home, "binB");
    mkdirSync(binA, { recursive: true });
    mkdirSync(binB, { recursive: true });
    writeFileSync(join(binA, "ptool"), "x");
    writeFileSync(join(binB, "ptool"), "x");
    chmodSync(join(binA, "ptool"), 0o755);
    chmodSync(join(binB, "ptool"), 0o755);

    const out = shadowedNames(baseReport(), "linux", { HOME: home, PATH: `${binA}:${binB}` });

    expect(out.ok).toBe(false);
    expect(out.shadowed[0].hits.every((h) => h.scope === "user")).toBe(true);
  });
});
