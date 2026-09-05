import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diffTools, snapshotFrom, writeSnapshot, loadSnapshot, type Snapshot } from "../src/snapshot.js";
import type { ScanReport, ToolEntry } from "../src/scan.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toolscan-snapshot-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function report(tools: ToolEntry[], truncated = false): ScanReport {
  return { ok: true, elapsedMs: 1, truncated, pathEntries: 0, tools };
}

const tool = (name: string, relPath: string): ToolEntry => ({ name, path: join(root, relPath), source: "root" });

describe("snapshot", () => {
  it("round-trips through writeSnapshot/loadSnapshot", () => {
    const snap = snapshotFrom(report([tool("a", "a.cmd")]), "win32", "2026-09-03T00:00:00.000Z");
    const file = join(root, "snap.json");
    writeSnapshot(file, snap);

    const loaded = loadSnapshot(file);
    expect(loaded.format).toBe("toolscan-snapshot/1");
    expect(loaded.tools).toEqual(snap.tools);
  });

  it("rejects a file that is not a snapshot", () => {
    const file = join(root, "not-snap.json");
    writeFileSync(file, JSON.stringify({ hello: "world" }));

    expect(() => loadSnapshot(file)).toThrow(/not a toolscan snapshot/);
  });
});

describe("loadSnapshot — hostile input sweep (B4)", () => {
  const write = (name: string, content: string): string => {
    const file = join(root, name);
    writeFileSync(file, content);
    return file;
  };

  it("rejects an empty file (fail closed, never silent)", () => {
    const file = write("empty.json", "   ");
    expect(() => loadSnapshot(file)).toThrow(/is empty/);
  });

  it("rejects invalid JSON with the parse reason", () => {
    const file = write("broken.json", '{"tools": [');
    expect(() => loadSnapshot(file)).toThrow(/not valid JSON/);
  });

  it("rejects a non-object root", () => {
    const file = write("array.json", "[1,2,3]");
    expect(() => loadSnapshot(file)).toThrow(/not a toolscan snapshot/);
  });

  it("rejects an unreadable file", () => {
    expect(() => loadSnapshot(join(root, "does-not-exist.json"))).toThrow(/cannot be read/);
  });

  it("rejects path traversal in a reported path", () => {
    const file = write(
      "traversal.json",
      JSON.stringify({
        format: "toolscan-snapshot/1",
        tools: [{ name: "evil", path: "../../somewhere/tool", source: "root" }],
      }),
    );
    expect(() => loadSnapshot(file)).toThrow(/tools\[0\].*path must be absolute/s);
  });

  it("rejects duplicate tool names", () => {
    const file = write(
      "dupes.json",
      JSON.stringify({
        format: "toolscan-snapshot/1",
        tools: [
          { name: "toolx", path: join(root, "a.cmd"), source: "PATH" },
          { name: "toolx", path: join(root, "b.cmd"), source: "root" },
        ],
      }),
    );
    expect(() => loadSnapshot(file)).toThrow(/duplicate tool name\(s\) toolx/);
  });

  it("rejects separators smuggled into a name", () => {
    const file = write(
      "sep.json",
      JSON.stringify({
        format: "toolscan-snapshot/1",
        tools: [{ name: "a/b", path: join(root, "a.cmd"), source: "PATH" }],
      }),
    );
    expect(() => loadSnapshot(file)).toThrow(/path separators/);
  });

  it("rejects absurd field sizes", () => {
    const file = write(
      "huge.json",
      JSON.stringify({
        format: "toolscan-snapshot/1",
        tools: [{ name: "x".repeat(300), path: join(root, "a.cmd"), source: "PATH" }],
      }),
    );
    expect(() => loadSnapshot(file)).toThrow(/exceeds 256/);
  });

  it("rejects a non-object tool entry with the offending index", () => {
    const file = write(
      "garbage-entry.json",
      JSON.stringify({ format: "toolscan-snapshot/1", tools: ["toolx"] }),
    );
    expect(() => loadSnapshot(file)).toThrow(/tools\[0\].*not an object/s);
  });

  it("still accepts a valid snapshot written by an older writer (back-compat)", () => {
    const file = write(
      "valid.json",
      JSON.stringify({
        format: "toolscan-snapshot/1",
        date: "2026-09-03T00:00:00.000Z",
        platform: "win32",
        tools: [{ name: "tool1", path: join(root, "tool1.cmd"), source: "PATH" }],
      }),
    );
    const loaded = loadSnapshot(file);
    expect(loaded.tools[0].name).toBe("tool1");
  });
});

describe("diffTools", () => {
  it("reports added, removed and changed", () => {
    const before = [tool("a", "a.cmd"), tool("b", "b.cmd"), tool("c", "c1.cmd")];
    const after = [tool("b", "b.cmd"), tool("c", "c2.cmd"), tool("d", "d.cmd")];

    const out = diffTools(before, after);

    expect(out.ok).toBe(false);
    expect(out.added.map((x) => x.name)).toEqual(["d"]);
    expect(out.removed.map((x) => x.name)).toEqual(["a"]);
    expect(out.changed).toEqual([{ name: "c", from: join(root, "c1.cmd"), to: join(root, "c2.cmd") }]);
    expect(out.moved).toEqual([]);
  });

  it("is clean for an identical tool set", () => {
    const both = [tool("a", "a.cmd"), tool("b", "b.cmd")];

    expect(diffTools(both, both).ok).toBe(true);
  });

  it("detects a rename as moved (same content, different path) only with --moves", () => {
    // Identical bytes, different names and paths — a classic launcher rename.
    writeFileSync(join(root, "old-name.cmd"), "same bytes\n");
    writeFileSync(join(root, "new-name.cmd"), "same bytes\n");
    const before = [tool("old-name", "old-name.cmd")];
    const after = [tool("new-name", "new-name.cmd")];

    const plain = diffTools(before, after);
    expect(plain.moved).toEqual([]);
    expect(plain.added.map((x) => x.name)).toEqual(["new-name"]);
    expect(plain.removed.map((x) => x.name)).toEqual(["old-name"]);

    const moved = diffTools(before, after, { moves: true });
    expect(moved.ok).toBe(false);
    expect(moved.moved).toEqual([{ name: "new-name", from: "old-name", to: join(root, "new-name.cmd") }]);
    expect(moved.added).toEqual([]);
    expect(moved.removed).toEqual([]);
  });

  it("does not treat a real add+remove pair as a move", () => {
    writeFileSync(join(root, "gone.cmd"), "gone\n");
    writeFileSync(join(root, "fresh.cmd"), "different content entirely\n");
    const before = [tool("gone", "gone.cmd")];
    const after = [tool("fresh", "fresh.cmd")];

    const out = diffTools(before, after, { moves: true });

    expect(out.moved).toEqual([]);
    expect(out.added.map((x) => x.name)).toEqual(["fresh"]);
    expect(out.removed.map((x) => x.name)).toEqual(["gone"]);
  });
});