// Hermetic tests for src/verify.ts + providers — run on ANY host OS because
// providers are pure functions and existence probing uses temp dirs.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { providerFor, parseEntriesFile, verifyEntries } from "../src/verify.js";

describe("parseEntriesFile", () => {
  it("splits lines, strips blanks and # comments", () => {
    const text = "# comment\nC:\\bin\n\n~/tools\nC:\\other ; trailing is NOT split (single entry per line)\n";
    expect(parseEntriesFile(text)).toEqual(["C:\\bin", "~/tools", "C:\\other ; trailing is NOT split (single entry per line)"]);
  });
});

describe("win32 provider", () => {
  const p = providerFor("win32");
  const env = { USERPROFILE: "C:\\Users\\t", ProgramFiles: "C:\\Program Files" };

  it("expands %VAR% tokens", () => {
    expect(p.expandTokens("%USERPROFILE%\\bin", env)).toBe("C:\\Users\\t\\bin");
  });
  it("leaves unknown tokens literal (honest)", () => {
    expect(p.expandTokens("%NOPE%\\bin", env)).toBe("%NOPE%\\bin");
  });
  it("classifies user scope under USERPROFILE", () => {
    expect(p.scopeOf("C:\\Users\\t\\AppData", env)).toBe("user");
  });
  it("classifies machine scope under Program Files", () => {
    expect(p.scopeOf("C:\\Program Files\\Git\\cmd", env)).toBe("machine");
  });
  it("unknown scope for relative entries — never a guess", () => {
    expect(p.scopeOf("relative\\dir", env)).toBe("unknown");
  });
});

describe("posix provider", () => {
  const p = providerFor("posix");
  const env = { HOME: "/home/t" };

  it("expands $HOME and ~ tokens", () => {
    expect(p.expandTokens("$HOME/bin", env)).toBe("/home/t/bin");
    expect(p.expandTokens("~/bin", env)).toBe("/home/t/bin");
    expect(p.expandTokens("${HOME}/x", env)).toBe("/home/t/x");
  });
  it("classifies machine scope for /usr-local", () => {
    expect(p.scopeOf("/usr/local/bin", env)).toBe("machine");
  });
  it("classifies user scope under HOME", () => {
    expect(p.scopeOf("/home/t/.cargo/bin", env)).toBe("user");
  });
});

describe("verifyEntries (universal existence check)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tsverify-"));
  const good = fs.mkdtempSync(path.join(base, "good-"));
  const missingDir = path.join(base, "does-not-exist");
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it("all-existing entries -> ok: true with scope labels", () => {
    const r = verifyEntries(`${good}\n`, process.platform, {});
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(1);
    expect(r.entries[0].exists).toBe(true);
  });

  it("missing entry -> ok: false with typed problem, exit-1 payload", () => {
    const r = verifyEntries(`${missingDir}\n`, process.platform, {});
    expect(r.ok).toBe(false);
    expect(r.entries[0].problem).toBe("path does not exist");
  });

  it("mixed report carries per-entry results (fail-closed, not fail-fast)", () => {
    const r = verifyEntries(`${good}\n${missingDir}\n`, process.platform, {});
    expect(r.checked).toBe(2);
    expect(r.entries.map((e) => e.exists)).toEqual([true, false]);
    expect(r.ok).toBe(false);
  });

  it("unexpanded tokens are the reported problem, not a mangled stat", () => {
    const r = verifyEntries("%DEFINITELY_NOT_SET%\\bin\n", "win32", {});
    expect(r.ok).toBe(false);
    expect(r.entries[0].problem).toBe("unexpanded token(s) in entry");
  });

  it("case-insensitive existence on win32 semantics (skipped on posix hosts)", () => {
    const r = verifyEntries(`${good.toUpperCase()}\n`, "win32", {});
    expect(r.entries[0].exists).toBe(fs.existsSync(good));
  });
});
