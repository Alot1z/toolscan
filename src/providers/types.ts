/**
 * Pluggable verification providers — ECOv5 T5 Phase B.
 *
 * A provider owns the OS-specific knowledge behind two universal questions:
 *   1. entry expansion: a PATH entry may carry OS tokens (%USERPROFILE%\bin,
 *      ~/bin, $HOME/bin) — expandTokens resolves them against an env map.
 *   2. scope classification: machine-wide vs per-user. Windows: HKLM-style
 *      prefixes (Program Files, system dirs) are machine; AppData/user profile
 *      is user. Posix: /usr*, /opt, /bin, /sbin are machine; $HOME is user.
 * Providers are pure functions of (entry, env) — no I/O, so they are
 * hermetically testable on any host OS. Filesystem existence probing (the
 * universal check) lives in verify.ts and never in a provider.
 */

export type PathScope = "machine" | "user" | "unknown";

export interface Provider {
  /** Expand OS tokens in a PATH entry against env; returns the literal entry when no tokens. */
  expandTokens(entry: string, env: Record<string, string>): string;
  /** Classify the scope of an (already-expanded) entry. */
  scopeOf(entry: string, env: Record<string, string>): PathScope;
}

export interface VerifyEntryResult {
  raw: string;
  expanded: string;
  scope: PathScope;
  exists: boolean;
  /** Empty when exists; the reason when not. */
  problem?: string;
}

export interface VerifyReport {
  ok: boolean;
  platform: string;
  checked: number;
  entries: VerifyEntryResult[];
}
