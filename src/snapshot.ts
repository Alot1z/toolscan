/**
 * Snapshot format, diff and drift.
 *
 * A snapshot is a point-in-time scan. `diff` compares two tool sets (or a
 * snapshot against a live scan) and reports added / removed / changed —
 * and, with `--moves`, renamed launchers whose content hash matches. Move
 * detection is deliberately bounded: only launchers at or below
 * `MOVE_HASH_MAX_BYTES` are hashed, so a 100 MB runtime never gets read.
 */
import * as fs from "node:fs";

import type { ScanReport, ToolEntry } from "./scan.js";
import { hashLauncher } from "./scan.js";

export interface Snapshot {
  format: "toolscan-snapshot/1";
  date: string;
  platform: string;
  truncated: boolean;
  pathEntries: number;
  tools: ToolEntry[];
}

export interface DiffEntry {
  name: string;
  path: string;
}

export interface DiffReport {
  ok: boolean;
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: Array<{ name: string; from: string; to: string }>;
  moved: Array<{ name: string; from: string; to: string }>;
}

export function snapshotFrom(report: ScanReport, platform: string, date = new Date().toISOString()): Snapshot {
  return {
    format: "toolscan-snapshot/1",
    date,
    platform,
    truncated: report.truncated,
    pathEntries: report.pathEntries,
    tools: report.tools,
  };
}

export function loadSnapshot(file: string): Snapshot {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as Partial<Snapshot>;
  if (!Array.isArray(parsed.tools)) {
    throw new Error(`${file} is not a toolscan snapshot (missing tools array)`);
  }
  return parsed as Snapshot;
}

export function writeSnapshot(file: string, snapshot: Snapshot): void {
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export function diffTools(a: readonly ToolEntry[], b: readonly ToolEntry[], options: { moves?: boolean } = {}): DiffReport {
  const am = new Map(a.map((t) => [t.name, t.path]));
  const bm = new Map(b.map((t) => [t.name, t.path]));

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: Array<{ name: string; from: string; to: string }> = [];

  for (const [name, path] of bm) {
    if (!am.has(name)) added.push({ name, path });
  }
  for (const [name, path] of am) {
    if (!bm.has(name)) removed.push({ name, path });
  }
  for (const [name, to] of bm) {
    const from = am.get(name);
    if (from !== undefined && from !== to) changed.push({ name, from, to });
  }

  const moved: Array<{ name: string; from: string; to: string }> = [];
  if (options.moves) {
    // A rename shows up as one removed name and one added name whose files
    // hash identically. Hash only size-bounded launchers.
    const removedByHash = new Map<string, string>();
    for (const r of removed) {
      const h = hashLauncher(r.path);
      if (h) removedByHash.set(h, r.name);
    }
    const keptAdded: DiffEntry[] = [];
    const movedAway = new Set<string>();
    for (const a of added) {
      const h = hashLauncher(a.path);
      const from = h ? removedByHash.get(h) : undefined;
      if (from !== undefined && from !== a.name) {
        moved.push({ name: a.name, from, to: a.path });
        movedAway.add(from);
      } else {
        keptAdded.push(a);
      }
    }
    added.length = 0;
    added.push(...keptAdded);
    const keptRemoved = removed.filter((r) => !movedAway.has(r.name));
    removed.length = 0;
    removed.push(...keptRemoved);
  }

  return { ok: added.length + removed.length + changed.length + moved.length === 0, added, removed, changed, moved };
}