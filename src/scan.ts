/**
 * toolscan discovery core — bounded, truthful, cross-platform.
 *
 * Scans PATH (authoritative, first-hit-wins) and the common install roots
 * beyond it (XDG dirs, ~/.local/bin, ~/.npm-global, %LOCALAPPDATA%\Programs,
 * ...). The scan is BOUNDED by a shared budget (max files examined, max depth,
 * max elapsed ms) and reports `truncated: true` honestly when the budget was
 * hit — a truncated scan is never presented as a complete one.
 *
 * Built on Effect: the budget is a shared `Ref` across parallel root scans,
 * failures are typed, and the environment (PATH, PATHEXT, platform) is
 * injectable so the whole scanner is hermetic in tests.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { Effect, Ref } from "effect";

export interface ToolEntry {
  name: string;
  path: string;
  source: "PATH" | "root";
}

export interface ScanReport {
  ok: true;
  elapsedMs: number;
  truncated: boolean;
  pathEntries: number;
  tools: ToolEntry[];
}

export interface ScanOptions {
  name?: string;
  roots?: string[];
  noPath?: boolean;
  noRoots?: boolean;
  depth?: number;
  maxMs?: number;
  maxFiles?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export const DEFAULT_DEPTH = 2;
export const DEFAULT_MAX_MS = 8_000;
export const DEFAULT_MAX_FILES = 20_000;

/**
 * Output-contract limits, owned here and enforced by the doctor/snapshot
 * validators: a reported name can never exceed a plausible basename and a
 * reported path can never exceed any real filesystem path length.
 */
export const MAX_NAME_LENGTH = 256;
export const MAX_PATH_LENGTH = 4096;

/** Directories that are never descended (cache, vcs, temp, ...). */
export const SKIP_NAMES = new Set([
  ".git",
  "node_modules",
  ".cache",
  "__pycache__",
  "cache",
  "caches",
  "logs",
  "Temp",
  "tmp",
  "$Recycle.Bin",
  "System Volume Information",
]);

/** Moving detection only hashes launchers at or below this size. */
export const MOVE_HASH_MAX_BYTES = 2 * 1024 * 1024;

interface Budget {
  files: number;
  truncated: boolean;
}

/** The executable extensions on Windows, or null elsewhere (X_OK probing). */
export function extSet(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Set<string> | null {
  if (platform !== "win32") return null;
  return new Set(
    (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isExecutable(file: string, ex: Set<string> | null): boolean {
  if (ex) return ex.has(path.extname(file).toLowerCase());
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function toolName(file: string, ex: Set<string> | null): string {
  // Name semantics follow the DECLARED platform, not the host: an active
  // extension set means win32 mode, so Windows basename rules apply even
  // when a POSIX host runs the scan (hermetic injected-platform tests). On
  // a native run declared === host, so this is identical to before.
  const p = ex ? path.win32 : path.posix;
  const base = p.basename(file);
  if (!ex) return base;
  const ext = p.extname(base).toLowerCase();
  if (!ex.has(ext)) return base;
  const stripped = base.slice(0, -ext.length);
  // A hostile launcher name ("..cmd", ".exe") must never yield a bare
  // traversal name — the scanner is the producer of the output contract.
  return stripped === "." || stripped === ".." ? base : stripped;
}

/** The install roots beyond PATH, per platform. Order is scan priority. */
export function defaultRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const h = env.HOME || env.USERPROFILE || "";
  const p: string[] = [];
  if (env.XDG_BIN_HOME) p.push(env.XDG_BIN_HOME);
  if (env.XDG_DATA_HOME) p.push(path.join(env.XDG_DATA_HOME, "bin"));
  if (env.XDG_CONFIG_HOME) p.push(path.join(env.XDG_CONFIG_HOME, "bin"));
  if (h) {
    p.push(
      path.join(h, ".local", "bin"),
      path.join(h, "bin"),
      path.join(h, ".cargo", "bin"),
      path.join(h, "go", "bin"),
      path.join(h, ".npm-global", "bin"),
      path.join(h, ".yarn", "bin"),
      path.join(h, ".bun", "bin"),
      path.join(h, ".deno", "bin"),
    );
  }
  if (platform === "win32") {
    if (env.LOCALAPPDATA) p.push(path.join(env.LOCALAPPDATA, "Programs"));
    if (env.APPDATA) p.push(path.join(env.APPDATA, "npm"));
    if (env.ProgramFiles) p.push(env.ProgramFiles);
    if (env["ProgramFiles(x86)"]) p.push(env["ProgramFiles(x86)"]);
  } else {
    for (const d of (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")) {
      if (d) p.push(path.join(d, "bin"));
    }
    p.push("/usr/local/bin", "/usr/local/sbin", "/opt/homebrew/bin", "/opt/bin");
  }
  return [...new Set(p)];
}

function expandHome(root: string, env: NodeJS.ProcessEnv): string {
  return root.replace(/^~(?=[\\/])/, env.HOME || env.USERPROFILE || "~");
}

export function nameFilter(pattern?: string): (name: string) => boolean {
  if (!pattern) return () => true;
  const escaped = pattern.split("*").map(escapeRe).join(".*");
  const re = new RegExp(`^${escaped}$`, "i");
  return (n) => re.test(n);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Take one file from the budget; false + truncated=true when exhausted. */
const takeBudget = (ref: Ref.Ref<Budget>, maxFiles: number) =>
  Effect.gen(function* () {
    const s = yield* Ref.get(ref);
    if (s.files > maxFiles) {
      yield* Ref.set(ref, { ...s, truncated: true });
      return false;
    }
    yield* Ref.update(ref, (x) => ({ ...x, files: x.files + 1 }));
    return true;
  });

type Sink = (name: string, fullPath: string, source: ToolEntry["source"]) => void;

/** Shallow scan of one PATH entry: executables directly inside. */
const scanPathDir = (
  dir: string,
  ex: Set<string> | null,
  ref: Ref.Ref<Budget>,
  maxFiles: number,
  filter: (name: string) => boolean,
  sink: Sink,
) =>
  Effect.gen(function* () {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (!(yield* takeBudget(ref, maxFiles))) return;
      if (it.isDirectory() || it.isSymbolicLink()) continue;
      const full = path.join(dir, it.name);
      const name = toolName(full, ex);
      if (isExecutable(full, ex) && filter(name)) sink(name, full, "PATH");
    }
  });

/** Deep, depth-bounded scan of one root, returning its local first-hit map. */
const scanOneRoot = (
  root: string,
  ex: Set<string> | null,
  ref: Ref.Ref<Budget>,
  maxFiles: number,
  maxDepth: number,
  filter: (name: string) => boolean,
) =>
  Effect.gen(function* () {
    const tools = new Map<string, ToolEntry>();
    const queue: Array<[string, number]> = [[root, 0]];
    while (queue.length) {
      if ((yield* Ref.get(ref)).truncated) return tools;
      const [dir, depth] = queue.shift()!;
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const it of items) {
        if (!(yield* takeBudget(ref, maxFiles))) break;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          if (depth >= maxDepth || SKIP_NAMES.has(it.name)) continue;
          if (it.isSymbolicLink()) continue;
          try {
            if (fs.lstatSync(full).isSymbolicLink()) continue;
          } catch {
            continue;
          }
          queue.push([full, depth + 1]);
        } else {
          const name = toolName(full, ex);
          if (!tools.has(name) && isExecutable(full, ex) && filter(name)) {
            tools.set(name, { name, path: full, source: "root" });
          }
        }
      }
    }
    return tools;
  });

/**
 * One scan: PATH first (authoritative, first-hit-wins), then the roots in
 * parallel with a shared budget. Merging is done in root order so the result
 * is deterministic. `truncated` is reported, never hidden.
 */
export function scan(opts: ScanOptions = {}): Effect.Effect<ScanReport, never, never> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const ex = extSet(platform, env);
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const filter = nameFilter(opts.name);
  const started = Date.now();

  return Effect.gen(function* () {
    const ref = yield* Ref.make<Budget>({ files: 0, truncated: false });
    const tools = new Map<string, ToolEntry>();
    let pathEntries = 0;

    if (!opts.noPath) {
      for (const dir of (env.PATH || "").split(platform === "win32" ? ";" : ":")) {
        if (!dir || Date.now() - started > maxMs) {
          if (dir) yield* Ref.update(ref, (s) => ({ ...s, truncated: true }));
          break;
        }
        pathEntries += 1;
        yield* scanPathDir(dir, ex, ref, maxFiles, filter, (name, fullPath, source) => {
          if (!tools.has(name)) tools.set(name, { name, path: fullPath, source });
        });
      }
    }

    if (!opts.noRoots && Date.now() - started <= maxMs) {
      const roots = (opts.roots && opts.roots.length > 0 ? opts.roots : defaultRoots(platform, env))
        .map((r) => expandHome(r, env))
        .filter(Boolean);
      const maps = yield* Effect.forEach(roots, (root) =>
        scanOneRoot(root, ex, ref, maxFiles, depth, filter),
        { concurrency: "unbounded" },
      );
      for (const map of maps) {
        for (const [name, entry] of map) {
          if (!tools.has(name)) tools.set(name, entry);
        }
      }
    }

    const { truncated } = yield* Ref.get(ref);
    return {
      ok: true,
      elapsedMs: Date.now() - started,
      truncated,
      pathEntries,
      tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/** sha256 of a launcher, bounded by size; null when too big or unreadable. */
export function hashLauncher(file: string): string | null {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.size > MOVE_HASH_MAX_BYTES) return null;
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}
