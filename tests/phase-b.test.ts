import { describe, expect, it } from "vitest";

import { defaultRoots } from "../src/scan.js";
import { snapshotFrom } from "../src/snapshot.js";
import { providerFor } from "../src/verify.js";
import { verifyEntries } from "../src/verify.js";
import type { ScanReport } from "../src/scan.js";

describe("W3: win32 defaultRoots include user-scope global bins", () => {
  const env = {
    HOME: "C:\\Users\\t",
    USERPROFILE: "C:\\Users\\t",
    LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local",
    APPDATA: "C:\\Users\\t\\AppData\\Roaming",
    ProgramFiles: "C:\\Program Files",
  };

  it("adds cargo, go, python-user, pip-user roots on win32", () => {
    const roots = defaultRoots("win32", env);
    expect(roots).toContain("C:\\Users\\t\\.cargo\\bin");
    expect(roots).toContain("C:\\Users\\t\\go\\bin");
    expect(roots).toContain("C:\\Users\\t\\AppData\\Roaming\\Python\\Scripts");
    expect(roots).toContain("C:\\Users\\t\\AppData\\Local\\pip\\Scripts");
  });

  it("stays honest when env vars are absent", () => {
    const roots = defaultRoots("win32", {});
    expect(roots.every((r) => typeof r === "string")).toBe(true);
  });
});

describe("providerFor (add-one-file seam)", () => {
  it("win32 -> win32Provider, everything else -> posixProvider", () => {
    expect(providerFor("win32")).toBeDefined();
    expect(providerFor("linux")).toBe(providerFor("darwin"));
  });
});

describe("backward compat: existing scan/snapshot contract untouched", () => {
  it("snapshotFrom still emits the toolscan-snapshot/1 core fields", () => {
    const report = {
      elapsedMs: 1,
      truncated: false,
      pathEntries: 2,
      tools: [{ name: "x", path: "C:\\bin\\x.exe", source: "PATH" as const }],
    } as unknown as ScanReport;
    const snap = snapshotFrom(report, "win32");
    expect(snap.format).toBe("toolscan-snapshot/1");
    expect(snap.platform).toBe("win32");
    expect(snap.truncated).toBe(false);
    expect(snap.pathEntries).toBe(2);
  });
});

describe("live-ish verify via entries text (fail-closed contract)", () => {
  it("report.ok is false exactly when any entry fails", () => {
    const r = verifyEntries("C:\\definitely-missing-xyz\\bin\n", "win32", {});
    expect(r.ok).toBe(false);
    expect(r.entries[0].problem).toBe("path does not exist");
  });
});
