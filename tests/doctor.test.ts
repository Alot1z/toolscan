import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditReport, doctor, validateScanReport, validateToolEntry } from "../src/doctor.js";
import { MAX_NAME_LENGTH, MAX_PATH_LENGTH, toolName } from "../src/scan.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toolscan-doctor-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validateToolEntry — the output contract, hostile payloads", () => {
  // Factory, not a const: the describe body runs before beforeEach assigns root.
  const valid = () => ({ name: "node", path: join(root, "node.exe"), source: "PATH" as const });

  it("accepts a well-formed entry", () => {
    expect(validateToolEntry(valid())).toEqual([]);
  });

  it("rejects non-object and null entries", () => {
    expect(validateToolEntry("node").join(" ")).toMatch(/not an object/);
    expect(validateToolEntry(null).join(" ")).toMatch(/not an object/);
    expect(validateToolEntry(undefined).join(" ")).toMatch(/not an object/);
  });

  it("rejects a relative reported path (absolute-only contract) and dot-only names", () => {
    // win32 semantics: "/a/../../x" IS absolute (current-drive root), so the
    // decisive hostile cases are the genuinely relative ones plus dot names.
    for (const traversal of ["..\\..\\somewhere\\tool", "somewhere/tool", "tool"] ) {
      const problems = validateToolEntry({ ...valid(), path: traversal }).join(" ");
      expect(problems).toMatch(/path must be absolute/);
    }
    expect(validateToolEntry({ ...valid(), name: ".." }).join(" ")).toMatch(/\"\.\.\"/);
  });

  it("rejects a name that carries path separators (name-is-not-a-path contract)", () => {
    expect(validateToolEntry({ ...valid(), name: "../evil" }).join(" ")).toMatch(/must not contain path separators/);
    expect(validateToolEntry({ ...valid(), name: "a\\b" }).join(" ")).toMatch(/must not contain path separators/);
  });

  it("rejects absurd field sizes and empty fields", () => {
    expect(validateToolEntry({ ...valid(), name: "x".repeat(MAX_NAME_LENGTH + 1) }).join(" ")).toMatch(/exceeds 256/);
    expect(validateToolEntry({ ...valid(), path: "C:\\" + "x".repeat(MAX_PATH_LENGTH) }).join(" ")).toMatch(/exceeds 4096/);
    expect(validateToolEntry({ ...valid(), name: "" }).join(" ")).toMatch(/non-empty/);
    expect(validateToolEntry({ ...valid(), path: "" }).join(" ")).toMatch(/non-empty/);
  });

  it("rejects an unknown source", () => {
    expect(validateToolEntry({ ...valid(), source: "everywhere" }).join(" ")).toMatch(/source must be/);
  });

  it("toolName never yields a bare traversal name from a hostile launcher (producer pin)", () => {
    // A launcher literally named "..cmd" must keep its extension in reports
    // rather than degrade to "..".
    const ex = new Set([".cmd"]);
    expect(toolName("C:\\x\\..cmd", ex)).toBe("..cmd");
    expect(toolName("C:\\x\\.exe", ex)).toBe(".exe");
    expect(toolName("C:\\x\\normal.cmd", ex)).toBe("normal");
  });
});

describe("validateScanReport — schema validity", () => {
  const good = () => ({
    ok: true,
    elapsedMs: 5,
    truncated: false,
    pathEntries: 1,
    tools: [{ name: "node", path: join(root, "node.exe"), source: "PATH" }],
  });

  it("accepts a contract-conformant report", () => {
    expect(validateScanReport(good())).toEqual([]);
  });

  it("rejects wrong types and negative counters", () => {
    expect(validateScanReport(null).join(" ")).toMatch(/not an object/);
    expect(validateScanReport({ ...good(), ok: false }).join(" ")).toMatch(/ok must be true/);
    expect(validateScanReport({ ...good(), elapsedMs: -1 }).join(" ")).toMatch(/elapsedMs/);
    expect(validateScanReport({ ...good(), truncated: "no" }).join(" ")).toMatch(/truncated/);
    expect(validateScanReport({ ...good(), pathEntries: 1.5 }).join(" ")).toMatch(/pathEntries/);
  });

  it("rejects duplicate tool names", () => {
    const r = good();
    r.tools.push({ ...r.tools[0] });
    const problems = validateScanReport(r).join(" ");
    expect(problems).toMatch(/duplicate name "node"/);
  });

  it("pinpoints the offending index in tools", () => {
    const r = good();
    r.tools.push({ name: "", path: "relative", source: "PATH" });
    const problems = validateScanReport(r);
    expect(problems.some((p) => p.startsWith("tools[1]:"))).toBe(true);
  });
});

describe("auditReport — the full oracle", () => {
  it("is ALL GREEN on a valid, existing, complete report", () => {
    writeFileSync(join(root, "real.cmd"), "x");
    const out = auditReport({
      ok: true,
      elapsedMs: 3,
      truncated: false,
      pathEntries: 1,
      tools: [{ name: "real", path: join(root, "real.cmd"), source: "root" }],
    });
    expect(out.ok).toBe(true);
    expect(out.checks.map((c) => c.name)).toEqual(["schema", "paths-exist", "complete-scan"]);
  });

  it("fails paths-exist for a schema-valid report pointing at nothing", () => {
    const out = auditReport({
      ok: true,
      elapsedMs: 3,
      truncated: false,
      pathEntries: 1,
      tools: [{ name: "ghost", path: join(root, "does-not-exist.cmd"), source: "root" }],
    });
    expect(out.checks.find((c) => c.name === "paths-exist")?.ok).toBe(false);
    expect(out.ok).toBe(false);
  });

  it("does not probe the filesystem on a schema-broken report (no crash on garbage)", () => {
    const out = auditReport({ ok: true, tools: "not-an-array" });
    expect(out.ok).toBe(false);
    expect(out.checks.find((c) => c.name === "schema")?.ok).toBe(false);
    expect(out.checks.find((c) => c.name === "paths-exist")?.detail).not.toMatch(/undefined/);
  });

  it("reports truncation honestly", () => {
    const out = auditReport({ ok: true, elapsedMs: 1, truncated: true, pathEntries: 0, tools: [] });
    expect(out.truncated).toBe(true);
    expect(out.checks.find((c) => c.name === "complete-scan")?.ok).toBe(false);
  });
});

describe("doctor — one shot over a real scan", () => {
  function winEnv(home: string): NodeJS.ProcessEnv {
    return { PATH: "", PATHEXT: ".CMD;.EXE", USERPROFILE: home };
  }

  it("is green on a bounded hermetic scan whose tools all exist", async () => {
    const home = join(root, "home");
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "doctor-tool.cmd"), "x");

    const report = await Effect.runPromise(
      doctor({ env: winEnv(home), platform: "win32", noPath: true, depth: 2 }),
    );

    expect(report.ok).toBe(true);
    expect(report.truncated).toBe(false);
  });

  it("reports complete-scan=false when the budget is exhausted", async () => {
    const home = join(root, "home");
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    for (let i = 0; i < 10; i++) writeFileSync(join(bin, `t${i}.cmd`), "x");

    const report = await Effect.runPromise(
      doctor({ env: winEnv(home), platform: "win32", noPath: true, maxFiles: 3 }),
    );

    expect(report.ok).toBe(false);
    expect(report.truncated).toBe(true);
  });
});
