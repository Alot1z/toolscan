/**
 * Windows provider — %VAR% token expansion + machine/user scope heuristics.
 * Pure functions; no registry I/O here (a registry probe can be layered later
 * behind the same interface without touching callers).
 */
import * as path from "node:path";

import type { PathScope, Provider } from "./types.js";

function expand(entry: string, env: Record<string, string>): string {
  return entry.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole);
}

const MACHINE_PREFIXES = [
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
  "C:\\Windows",
];

export const win32Provider: Provider = {
  expandTokens: expand,

  scopeOf(entry, env): PathScope {
    const p = entry.toLowerCase();
    // Anything under the user profile is user scope (AppData, tools, dotdirs).
    const profile = env.USERPROFILE ? expand("%USERPROFILE%", env).toLowerCase() : null;
    if (profile && (p === profile || p.startsWith(profile + "\\"))) return "user";
    if (MACHINE_PREFIXES.some((m) => p.startsWith(m.toLowerCase()))) return "machine";
    // Relative or unrecognized roots: honest unknown, never a guess.
    if (!path.win32.isAbsolute(entry)) return "unknown";
    return "unknown";
  },
};
