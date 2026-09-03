import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scan, type ScanOptions } from "../src/scan.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toolscan-scan-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Windows PATHEXT semantics with injected env — hermetic on any host. */
function winEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "", PATHEXT: ".CMD;.EXE", ...extra };
}

function put(rel: string, content = "x"): string {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

const run = (options: ScanOptions) => Effect.runPromise(scan(options));

describe("scan", () => {
  it("finds executables on PATH and in the common roots beyond it", async () => {
    const binA = join(root, "binA");
    mkdirSync(binA, { recursive: true });
    writeFileSync(join(binA, "tool1.cmd"), "x");
    const home = join(root, "home");
    put("home/.local/bin/tool2.cmd");

    const report = await run({
      env: winEnv({ PATH: binA, USERPROFILE: home }),
      platform: "win32",
    });

    expect(report.truncated).toBe(false);
    expect(report.pathEntries).toBe(1);
    const byName = new Map(report.tools.map((t) => [t.name, t]));
    expect(byName.get("tool1")).toMatchObject({ source: "PATH", path: join(binA, "tool1.cmd") });
    expect(byName.get("tool2")).toMatchObject({ source: "root", path: join(home, ".local", "bin", "tool2.cmd") });
  });

  it("skips non-executables on Windows (extension check)", async () => {
    const binA = join(root, "binA");
    mkdirSync(binA, { recursive: true });
    writeFileSync(join(binA, "tool.cmd"), "x");
    writeFileSync(join(binA, "notes.txt"), "x");

    const report = await run({ env: winEnv({ PATH: binA }), platform: "win32" });

    expect(report.tools.map((t) => t.name)).toEqual(["tool"]);
  });

  it("is first-hit-wins: earlier PATH entry beats later, PATH beats roots", async () => {
    const binA = join(root, "binA");
    const binB = join(root, "binB");
    const home = join(root, "home");
    mkdirSync(binA, { recursive: true });
    mkdirSync(binB, { recursive: true });
    writeFileSync(join(binA, "dup.cmd"), "x");
    writeFileSync(join(binB, "dup.cmd"), "x");
    put("home/.local/bin/dup.cmd");

    const report = await run({
      env: winEnv({ PATH: `${binA}${";"}${binB}`, USERPROFILE: home }),
      platform: "win32",
    });

    const dup = report.tools.find((t) => t.name === "dup");
    expect(dup?.path).toBe(join(binA, "dup.cmd"));
    expect(dup?.source).toBe("PATH");
  });

  it("reports truncation honestly when the file budget is exhausted", async () => {
    const binA = join(root, "binA");
    mkdirSync(binA, { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(binA, `t${i}.cmd`), "x");

    const report = await run({ env: winEnv({ PATH: binA }), platform: "win32", maxFiles: 5 });

    expect(report.truncated).toBe(true);
  });

  it("bounds root descent by depth", async () => {
    const home = join(root, "home");
    put("home/.local/bin/deep/a/b/tool.cmd");

    const shallow = await run({ env: winEnv({ USERPROFILE: home }), platform: "win32", noPath: true, depth: 2 });
    expect(shallow.tools.some((t) => t.name === "tool")).toBe(false);

    const deep = await run({ env: winEnv({ USERPROFILE: home }), platform: "win32", noPath: true, depth: 4 });
    expect(deep.tools.some((t) => t.name === "tool")).toBe(true);
  });

  it("never descends into SKIP_NAMES directories", async () => {
    const home = join(root, "home");
    put("home/.local/bin/node_modules/tool.cmd");
    put("home/.local/bin/real.cmd");

    const report = await run({ env: winEnv({ USERPROFILE: home }), platform: "win32", noPath: true });

    expect(report.tools.map((t) => t.name)).toEqual(["real"]);
  });

  it("applies the --name glob filter", async () => {
    const binA = join(root, "binA");
    mkdirSync(binA, { recursive: true });
    writeFileSync(join(binA, "tool-one.cmd"), "x");
    writeFileSync(join(binA, "other.cmd"), "x");

    const report = await run({ env: winEnv({ PATH: binA }), platform: "win32", name: "tool-*" });

    expect(report.tools.map((t) => t.name)).toEqual(["tool-one"]);
  });

  it("honours --no-path by scanning roots only", async () => {
    const binA = join(root, "binA");
    mkdirSync(binA, { recursive: true });
    writeFileSync(join(binA, "onpath.cmd"), "x");
    const home = join(root, "home");
    put("home/.local/bin/onroot.cmd");

    const report = await run({ env: winEnv({ PATH: binA, USERPROFILE: home }), platform: "win32", noPath: true });

    expect(report.pathEntries).toBe(0);
    expect(report.tools.map((t) => t.name)).toEqual(["onroot"]);
  });
});