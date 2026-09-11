/**
 * Shadowed-name report — ECOv6 S1 (2026-09-12).
 *
 * A shadowed name exists in MORE THAN ONE PATH entry with DIFFERENT targets:
 * the PATH order silently decides which one runs, and dual-profile setups
 * (KB #6704: machine vs user scopes for the same name) are the classic source.
 * The plain scan dedupes by name (first-hit-wins) and cannot answer this
 * question — this module re-walks PATH with the same executable semantics
 * as scanPathDir (extension check via extSet, executable probe) but keeps
 * EVERY hit per case-folded name, classified by provider scope.
 *
 * Pure data in, pure data out: no I/O beyond directory reads; the scope
 * heuristics come from the provider seam (win32 = machine/user prefixes,
 * posix = FHS prefixes) so the report reads the same on every OS.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { PathScope } from "./providers/types.js";
import type { ScanReport } from "./scan.js";
import { extSet, isExecutable, toolName } from "./scan.js";
import { providerFor } from "./verify.js";

export interface ShadowedHit {
  path: string;
  scope: PathScope;
}

export interface ShadowedName {
  name: string;
  hits: ShadowedHit[];
}

export interface ShadowedReport {
  ok: boolean;
  platform: string;
  checked: number;
  shadowed: ShadowedName[];
}

const SEP = (platform: NodeJS.Platform) => (platform === "win32" ? ";" : ":");

export function shadowedNames(
  report: ScanReport,
  platform: NodeJS.Platform,
  env: Record<string, string>,
): ShadowedReport {
  const provider = providerFor(platform);
  const ex = extSet(platform, env);
  // Case-insensitive everywhere: Windows filesystems are case-insensitive, and
  // a name differing only by case is a shadowing footgun on any OS.
  const byName = new Map<string, ShadowedHit[]>();
  const dirs = (env.PATH ?? "")
    .split(SEP(platform))
    .map((d) => d.trim())
    .filter(Boolean);
  for (const rawDir of dirs) {
    // Tokenized entries (%USERPROFILE%\bin, %TOOLROOT%) expand BEFORE walking:
    // a token that never reaches the filesystem cannot be walked, and the
    // report must address real directories (KB #6704 consumer shape).
    const dir = provider.expandTokens(rawDir, env);
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable/missing entry: not a shadow, nothing claimed
    }
    for (const it of items) {
      if (it.isDirectory() || it.isSymbolicLink()) continue;
      const full = path.join(dir, it.name);
      if (!isExecutable(full, ex)) continue;
      // Key by toolName (extension-stripped, matching scan semantics),
      // lower-cased for case-insensitive filesystems.
      const key = toolName(full, ex).toLowerCase();
      const list = byName.get(key) ?? [];
      list.push({ path: full, scope: provider.scopeOf(full, env) });
      byName.set(key, list);
    }
  }
  const shadowed: ShadowedName[] = [];
  for (const [key, hits] of byName) {
    // Same target reachable twice is not a shadow; require 2+ distinct paths.
    const distinct = hits.filter((h, i) => hits.findIndex((x) => x.path.toLowerCase() === h.path.toLowerCase()) === i);
    if (distinct.length >= 2) shadowed.push({ name: key, hits: distinct });
  }
  shadowed.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: shadowed.length === 0,
    platform,
    checked: dirs.length,
    shadowed,
  };
}
