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

/** Fallback prefixes for when env vars are absent (env-derived when present). */
const MACHINE_PREFIX_FALLBACK = [
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
  "C:\\Windows",
];

/**
 * Machine roots derived from env when available (hermetically testable,
 * Windows-on-D: correct), falling back to the classic C: literals.
 * Boundary-correct: a prefix must match at a separator, not mid-name
 * ("C:\WindowsApps" must not classify as machine via "C:\Windows").
 */
export function machinePrefixes(env: Record<string, string>): string[] {
  const derived = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramData,
    env.SystemRoot ?? env.windir ?? env.WINDIR,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  return derived.length > 0 ? derived : MACHINE_PREFIX_FALLBACK;
}

export const win32Provider: Provider = {
  expandTokens: expand,

  scopeOf(entry, env): PathScope {
    const p = entry.toLowerCase();
    // Anything under the user profile is user scope (AppData, tools, dotdirs).
    const profile = env.USERPROFILE ? expand("%USERPROFILE%", env).toLowerCase() : null;
    if (profile && (p === profile || p.startsWith(profile + "\\"))) return "user";
    const isMachine = machinePrefixes(env).some((m) => {
      const lm = m.toLowerCase().replace(/[\\/]+$/, "");
      return p === lm || p.startsWith(lm + "\\");
    });
    if (isMachine) return "machine";
    // Relative or unrecognized roots: honest unknown, never a guess.
    if (!path.win32.isAbsolute(entry)) return "unknown";
    return "unknown";
  },
};
