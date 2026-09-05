/**
 * toolscan doctor — the one-shot invariant oracle.
 *
 * Runs a real bounded scan, then audits the result against the documented
 * output contract (schema shape, unique names, absolute paths, existing
 * files, honest truncation). ALL GREEN = the scan surface holds on this
 * machine. `auditReport` is exported pure so tests and consumers can throw
 * hostile payloads at the contract without a filesystem.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { Effect } from "effect";

import { MAX_NAME_LENGTH, MAX_PATH_LENGTH, scan, type ScanOptions } from "./scan.js";
import type { ToolEntry } from "./scan.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  truncated: boolean;
  checks: DoctorCheck[];
}

/** Validate one value as a ToolEntry under the documented output contract. */
export function validateToolEntry(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return ["tool entry is not an object"];
  const t = value as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof t.name !== "string" || t.name.length === 0) {
    problems.push("name must be a non-empty string");
  } else {
    if (t.name.length > MAX_NAME_LENGTH) problems.push(`name exceeds ${MAX_NAME_LENGTH} chars`);
    if (/[/\\]/.test(t.name)) problems.push("name must not contain path separators");
    if (t.name === "." || t.name === "..") problems.push('name must not be "." or ".."');
    if (t.name.includes("\0")) problems.push("name must not contain NUL bytes");
  }
  if (typeof t.path !== "string" || t.path.length === 0) {
    problems.push("path must be a non-empty string");
  } else {
    if (t.path.length > MAX_PATH_LENGTH) problems.push(`path exceeds ${MAX_PATH_LENGTH} chars`);
    if (!path.isAbsolute(t.path)) problems.push("path must be absolute");
    if (t.path.includes("\0")) problems.push("path must not contain NUL bytes");
  }
  if (t.source !== "PATH" && t.source !== "root") problems.push('source must be "PATH" or "root"');
  return problems;
}

/** Validate any value as a scan report under the documented output contract. */
export function validateScanReport(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return ["report is not an object"];
  const r = value as Record<string, unknown>;
  const problems: string[] = [];
  if (r.ok !== true) problems.push("ok must be true");
  if (typeof r.elapsedMs !== "number" || !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0) {
    problems.push("elapsedMs must be a finite number >= 0");
  }
  if (typeof r.truncated !== "boolean") problems.push("truncated must be a boolean");
  if (typeof r.pathEntries !== "number" || !Number.isInteger(r.pathEntries) || r.pathEntries < 0) {
    problems.push("pathEntries must be a non-negative integer");
  }
  if (!Array.isArray(r.tools)) {
    problems.push("tools must be an array");
    return problems;
  }
  const seen = new Set<string>();
  r.tools.forEach((t, i) => {
    for (const p of validateToolEntry(t)) problems.push(`tools[${i}]: ${p}`);
    const name = (t as ToolEntry).name;
    if (typeof name === "string") {
      if (seen.has(name)) problems.push(`tools[${i}]: duplicate name "${name}"`);
      seen.add(name);
    }
  });
  return problems;
}

/** Audit any scan report against the documented output contract. Pure. */
export function auditReport(report: unknown): DoctorReport {
  const checks: DoctorCheck[] = [];

  const schema = validateScanReport(report);
  checks.push({
    name: "schema",
    ok: schema.length === 0,
    detail: schema.join("; ") || "report matches the documented output contract",
  });

  const tools = schema.length === 0 ? (report as { tools: ToolEntry[] }).tools : [];
  const missing = tools.filter((t) => !fs.existsSync(t.path)).map((t) => t.name);
  checks.push({
    name: "paths-exist",
    ok: missing.length === 0,
    detail: missing.length ? `missing on disk: ${missing.join(", ")}` : "every reported path exists",
  });

  const truncated = schema.length === 0 && (report as { truncated: boolean }).truncated;
  checks.push({
    name: "complete-scan",
    ok: !truncated,
    detail: truncated
      ? "scan hit its budget — raise --max-files/--max-ms and re-run"
      : "scan completed within budget",
  });

  return { ok: checks.every((c) => c.ok), truncated, checks };
}

/** One doctor pass: a real bounded scan, then the contract audit over it. */
export function doctor(opts: ScanOptions = {}): Effect.Effect<DoctorReport> {
  return Effect.map(scan(opts), auditReport);
}
