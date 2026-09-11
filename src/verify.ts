/**
 * `toolscan verify` — PATH-validation as a first-class, portable check type.
 *
 * Consumers (e.g. WEP) hand over an entries file: one PATH entry per line
 * (# comments and blank lines ignored). Every entry is:
 *   1. expanded via the platform provider (tokens resolved against env),
 *   2. scope-classified via the provider (machine | user | unknown),
 *   3. probed for existence on the filesystem (the UNIVERSAL check — no OS
 *      knowledge needed).
 * Fail-closed semantics match the rest of the CLI: exit 1 when any entry
 * fails, with the typed reasons in the JSON report.
 */
import * as fs from "node:fs";

import { posixProvider } from "./providers/posix.js";
import { win32Provider } from "./providers/win32.js";
import type { Provider, VerifyEntryResult, VerifyReport } from "./providers/types.js";

export function providerFor(platform: string): Provider {
  return platform === "win32" ? win32Provider : posixProvider;
}

export function parseEntriesFile(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function existsCaseInsensitive(dir: string): boolean {
  // Windows filesystems are case-insensitive; probe the exact path first and
  // only fall back to a directory listing when the direct stat misses.
  if (fs.existsSync(dir)) return true;
  if (process.platform !== "win32") return false;
  const parent = dir.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
  const base = dir.slice(parent.length + 1).toLowerCase();
  try {
    return fs.readdirSync(parent).some((e) => e.toLowerCase() === base);
  } catch {
    return false;
  }
}

export function verifyEntries(text: string, platform: string, env: Record<string, string>): VerifyReport {
  const provider = providerFor(platform);
  const entries: VerifyEntryResult[] = [];
  for (const raw of parseEntriesFile(text)) {
    const expanded = provider.expandTokens(raw, env);
    const scope = provider.scopeOf(expanded, env);
    // Tokens that failed to expand leave % or $ markers behind — that IS the
    // problem to report, not a silent "exists: false" on a mangled path.
    if (/%[^%]+%/.test(expanded) || /\$\{[^}]*\}/.test(expanded)) {
      entries.push({ raw, expanded, scope, exists: false, problem: "unexpanded token(s) in entry" });
      continue;
    }
    if (existsCaseInsensitive(expanded)) {
      entries.push({ raw, expanded, scope, exists: true });
    } else {
      entries.push({ raw, expanded, scope, exists: false, problem: "path does not exist" });
    }
  }
  return {
    ok: entries.every((e) => e.exists),
    platform,
    checked: entries.length,
    entries,
  };
}
