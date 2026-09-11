/**
 * Posix provider — $VAR / ${VAR} / ~ token expansion + machine/user scope.
 * Pure functions; per-provider counterpart of win32.ts.
 */
import * as path from "node:path";

import type { PathScope, Provider } from "./types.js";

function expand(entry: string, env: Record<string, string>): string {
  const tilde = entry === "~" || entry.startsWith("~/")
    ? (env.HOME ?? "") + entry.slice(1)
    : entry;
  return tilde.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced: string, plain: string) => {
    const name = braced ?? plain;
    return env[name] ?? whole;
  });
}

const MACHINE_PREFIXES = ["/usr", "/bin", "/sbin", "/opt", "/etc", "/lib"];

export const posixProvider: Provider = {
  expandTokens: expand,

  scopeOf(entry, env): PathScope {
    const p = entry.toLowerCase();
    const home = env.HOME ? env.HOME.toLowerCase() : null;
    if (home && (p === home || p.startsWith(home + "/"))) return "user";
    if (MACHINE_PREFIXES.some((m) => p === m || p.startsWith(m + "/"))) return "machine";
    if (!path.posix.isAbsolute(entry)) return "unknown";
    return "unknown";
  },
};
