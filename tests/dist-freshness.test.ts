// dist-freshness.test.ts — hermetic tests for scripts/check-dist.mjs.
// Positive: fixture repo whose committed dist matches its build → exit 0.
// Negative: committed dist older than what build.mjs emits → exit 1 + guidance.
// Integration: the real toolscan repo itself (dist is expected fresh) → exit 0.
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(__dirname, "..", "scripts", "check-dist.mjs");
const repoRoot = resolve(__dirname, "..");

let root: string | undefined;
const cleanups: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-dist-"));
  cleanups.push(root);
});

afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

function fixture(builtDist: string, committedDist: string) {
  const r = root as string;
  mkdirSync(join(r, "scripts"), { recursive: true });
  mkdirSync(join(r, "dist"), { recursive: true });
  writeFileSync(
    join(r, "scripts", "build.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync("dist/toolscan.mjs", ${JSON.stringify(builtDist)});\n`
  );
  writeFileSync(join(r, "dist", "toolscan.mjs"), committedDist);
  execSync("git init -q", { cwd: r });
  execSync(
    `git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init`,
    { cwd: r }
  );
  return r;
}

function run(r: string) {
  return spawnSync(process.execPath, [script, "--root", r], { encoding: "utf8" });
}

describe("check-dist", () => {
  it("passes when committed dist matches a fresh rebuild", () => {
    const r = fixture("FRESH-v2", "FRESH-v2");
    const p = run(r);
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("OK");
  });

  it("fails with guidance when committed dist is stale", () => {
    const r = fixture("FRESH-v2", "STALE-v1");
    const p = run(r);
    expect(p.status).toBe(1);
    expect(p.stderr).toContain("STALE");
    expect(p.stderr).toContain("npm run build");
  });

  it("fails when the build itself fails", () => {
    const r = root as string;
    mkdirSync(join(r, "scripts"), { recursive: true });
    writeFileSync(join(r, "scripts", "build.mjs"), 'process.exit(3);\n');
    const p = run(r);
    expect(p.status).toBe(1);
    expect(p.stderr).toContain("build failed");
  });

  it("integration: the real toolscan repo dist is fresh", () => {
    const p = spawnSync(process.execPath, [script, "--root", repoRoot], { encoding: "utf8" });
    expect(p.status).toBe(0);
  }, 120_000);
});
