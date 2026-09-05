import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Doctor-style suite for the agent-skill package (skills/toolscan) and its
// installer (scripts/install-skill.sh). Contract under test:
// - the skill is self-contained and machine-generic (no personal paths, no
//   secrets, parseable frontmatter) so it can deploy to any harness;
// - the installer's behavior contracts hold in both dry-run and real mode
//   (write nothing vs install everywhere, honest exits, refusal parity).
// Everything runs in hermetic HOME fixtures: the tests never touch the
// developer's real harness directories.
//
// Hermeticity note: the registry probes `command -v <bin>` against the real
// PATH, so presence tests must not depend on which CLIs this machine happens
// to have. Every test either (a) creates the harness config dir under the
// fixture HOME (present via config-dir regardless of PATH), or (b) uses the
// `agents` row — the only row with an empty bin field, decided purely by its
// config dir.

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = join(REPO, "skills", "toolscan");
const INSTALLER = join(REPO, "scripts", "install-skill.sh");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "toolscan-skill-pkg-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[], opts: { env?: Record<string, string> } = {}): {
  status: number; stdout: string; stderr: string;
} {
  try {
    const stdout = execFileSync("bash", [INSTALLER, ...args], {
      encoding: "utf8",
      cwd: REPO,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: process.env.PATH,
        ...opts.env,
      },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// A fake harness config dir: makes the registry row "present" via config-dir.
function fakeHarness(dir: string): void {
  mkdirSync(join(home, dir), { recursive: true });
}

function skillDir(harnessSkillDir: string): string {
  return join(home, harnessSkillDir, "toolscan");
}

describe("skill package — deployable by construction", () => {
  it("carries parseable frontmatter with name and description", () => {
    const raw = readFileSync(join(SRC, "SKILL.md"), "utf8");
    expect(raw.startsWith("---")).toBe(true);
    const fm = raw.split("---")[1];
    expect(fm).toMatch(/^name: toolscan$/m);
    expect(fm).toMatch(/^description: >/m);
    expect(fm).toMatch(/^version: \d/m);
  });

  it("is machine-generic: no personal absolute paths, usernames, or machine roots", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/([A-Z]:\\|\/e\/E-|\/home\/[a-z]+\/|C:\/Users\/|\/Users\/[a-z]+\/)/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it("contains no secrets or token material", () => {
    const raw = readFileSync(join(SRC, "SKILL.md"), "utf8");
    expect(raw).not.toMatch(/ghp_[A-Za-z0-9]|github_pat_|npm_[A-Za-z0-9]{20,}|token\s*=/i);
  });
});

describe("installer — --help and argument contracts", () => {
  it("--help exits 0 and names every valid harness id", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    for (const id of ["claude", "agents", "codex", "cursor"]) {
      expect(r.stdout).toContain(id);
    }
  });

  it("an unknown harness id exits 1 and lists the valid ids", () => {
    const r = run(["claude", "gemini"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown harness id 'gemini'/);
    expect(r.stderr).toMatch(/valid ids: claude agents codex cursor/);
  });

  it("an unknown option exits 1 with a hint", () => {
    const r = run(["--wat"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown option --wat/);
  });
});

describe("installer — dry run previews without writing", () => {
  it("lists install targets with the [id] label and writes nothing", () => {
    fakeHarness(".claude");
    fakeHarness(".codex");
    const before = readdirSync(home).sort();
    const r = run(["--dry-run", "claude", "codex"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("would install [claude]:");
    // Suffix match, not full-path equality: bash prints $HOME in POSIX form
    // (Git Bash maps the Windows temp dir to /tmp/...), so exact equality
    // against the Node-side path fails on Windows. The suffix is the same.
    expect(r.stdout).toContain(".claude/skills/toolscan");
    expect(r.stdout).not.toContain("[agents]"); // not selected
    expect(readdirSync(home).sort()).toEqual(before); // zero writes
    expect(existsSync(skillDir(".claude/skills"))).toBe(false);
  });

  it("skips an absent harness honestly and leaves nothing behind", () => {
    // `agents` has no bin field, so its presence is decided only by ~/.agents
    // — hermetic on any machine, unlike the CLI-backed rows.
    const r = run(["--dry-run", "agents"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skip [agents]");
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });
});

describe("installer — refusal guard protects foreign skills", () => {
  // Creating the foreign skill also creates the config dir, which is what
  // makes the `claude` row present — no PATH dependence.
  function withForeignSkill(): string {
    const foreign = skillDir(".claude/skills");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "SKILL.md"), "---\nname: handcrafted\n---\ndo not delete\n");
    return foreign;
  }

  it("refuses in real mode with exit 1 and leaves the foreign skill untouched", () => {
    const foreign = withForeignSkill();
    const r = run(["claude"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/exists and is not a toolscan install/);
    expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toMatch(/handcrafted/);
  });

  it("previews the refusal in dry-run with the same exit 1 (preview ≡ real parity)", () => {
    withForeignSkill();
    const r = run(["--dry-run", "claude"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/would refuse \[claude\]/);
    expect(readFileSync(join(skillDir(".claude/skills"), "SKILL.md"), "utf8")).toMatch(/handcrafted/);
  });

  it("--force overwrites the foreign skill", () => {
    withForeignSkill();
    const r = run(["--force", "claude"]);
    expect(r.status).toBe(0);
    expect(readFileSync(join(skillDir(".claude/skills"), "SKILL.md"), "utf8")).toMatch(/^name: toolscan$/m);
  });
});

describe("installer — real install", () => {
  it("installs the skill into each present harness and reports the [id] label", () => {
    fakeHarness(".claude");
    fakeHarness(".cursor");
    const r = run(["claude", "cursor"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Installed [claude]:");
    expect(r.stdout).toContain("Installed [cursor]:");
    expect(readFileSync(join(skillDir(".claude/skills"), "SKILL.md"), "utf8")).toMatch(/^name: toolscan$/m);
    // cursor's convention is skills-cursor (kept in sync with the Ix registry)
    expect(readFileSync(join(skillDir(".cursor/skills-cursor"), "SKILL.md"), "utf8")).toMatch(/^name: toolscan$/m);
  });

  it("re-installing over its own previous install succeeds without --force", () => {
    fakeHarness(".claude");
    expect(run(["claude"]).status).toBe(0);
    const r = run(["claude"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Installed [claude]:");
  });
});

describe("installer — JSON report", () => {
  it("is a single parseable document with honest per-host records", () => {
    fakeHarness(".claude");
    const r = run(["--dry-run", "--json", "claude", "agents"]);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.dryRun).toBe(true);
    const claude = report.hosts.find((h: { id: string }) => h.id === "claude");
    const agents = report.hosts.find((h: { id: string }) => h.id === "agents");
    expect(claude.action).toBe("would-install");
    expect(claude.dest).toMatch(/\.claude\/[sS]kills\/toolscan$/);
    expect(agents.action).toBe("skip");
    expect(agents.dest).toBeNull();
  });
});
