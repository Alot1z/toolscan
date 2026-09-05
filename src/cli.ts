/**
 * toolscan CLI — cross-platform tool discovery: PATH + XDG + common roots.
 * Bounded, truthful, JSON out. TypeScript + Effect core bundled to a
 * zero-dependency runtime artifact (dist/toolscan.mjs).
 *
 * Commands:
 *   toolscan                       scan PATH + roots, JSON to stdout
 *   toolscan list                  names only, one per line
 *   toolscan check <name>          print resolved path; exit 0 found / 1 not
 *   toolscan snapshot [--out F]    save a snapshot (default ./toolscan-snapshot.json)
 *   toolscan diff A.json [B.json]  added/removed/changed (B defaults to a live scan);
 *                                  exit 1 when anything changed; --moves detects renames
 *   toolscan missing --from F      report names (newline/comma list) not found; exit 1
 *   toolscan drift --baseline B [--out O]  scan, compare against a saved snapshot,
 *                                  rewrite the baseline, exit 1 when drifted (2 = truncated)
 *   toolscan doctor               one-shot invariant oracle over a live scan:
 *                                  schema, existing absolute paths, honest truncation
 *
 * Shared flags: --name GLOB --roots A,B --no-path --no-roots --depth N
 *               --max-ms N --max-files N --quiet --format json|text --moves --version
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { Effect } from "effect";

// Aliased: a local `function doctor` in this module would otherwise shadow
// the import inside the switch (hoisting), and the command would explode.
import { doctor as runDoctor, validateScanReport } from "./doctor.js";
import { scan, type ScanOptions } from "./scan.js";
import { diffTools, loadSnapshot, snapshotFrom, writeSnapshot } from "./snapshot.js";

const VERSION = "2.0.0";

interface ParsedArgs {
  command: "scan" | "list" | "check" | "snapshot" | "diff" | "missing" | "drift" | "doctor";
  positional: string[];
  scanOptions: ScanOptions;
  quiet: boolean;
  out: string | undefined;
  from: string | undefined;
  baseline: string | undefined;
  format: "json" | "text";
  moves: boolean;
}

function usage(): void {
  process.stderr.write(`toolscan — discover tools on PATH, XDG and common dirs (JSON out)

Commands:
  toolscan                       scan PATH + roots, JSON to stdout
  toolscan list                  names only, one per line
  toolscan check <name>          print the resolved path; exit 0 found / 1 not
  toolscan snapshot [--out F]    save a snapshot (default ./toolscan-snapshot.json)
  toolscan diff A.json [B.json]  compare snapshots (or a snapshot vs a live scan);
                                 exit 1 when tools were added, removed or changed
  toolscan missing --from F      read a name list (newline or comma) and report
                                 which are not found; exit 1 when any are missing
  toolscan drift --baseline B    scan, compare to a saved snapshot, rewrite the
                                 baseline; exit 1 when the machine drifted (2 = truncated)
  toolscan doctor                one-shot invariant oracle over a live scan (exit 1
                                 when any check fails; 2 when the scan truncated)

Flags: --name GLOB --roots A,B --no-path --no-roots --depth N --max-ms N
       --max-files N --format json|text --moves (diff: detect renames by
       content hash) --quiet --version
`);
}

function parseArgs(argv: string[]): ParsedArgs | null {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    process.exit(0);
  }
  if (argv.includes("--version")) {
    console.log(`toolscan ${VERSION}`);
    process.exit(0);
  }

  const commands = new Set(["scan", "list", "check", "snapshot", "diff", "missing", "drift", "doctor"]);
  let command: ParsedArgs["command"] = "scan";
  const positional: string[] = [];
  for (const a of argv) {
    if (a.startsWith("-")) continue;
    if (command === "scan" && commands.has(a as ParsedArgs["command"])) command = a as ParsedArgs["command"];
    else positional.push(a);
  }

  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const scanOptions: ScanOptions = {
    name: value("--name"),
    roots: value("--roots")?.split(","),
    noPath: argv.includes("--no-path"),
    noRoots: argv.includes("--no-roots"),
    depth: Number(value("--depth")) || undefined,
    maxMs: Number(value("--max-ms")) || undefined,
    maxFiles: Number(value("--max-files")) || undefined,
  };

  return {
    command,
    positional,
    scanOptions,
    quiet: argv.includes("--quiet"),
    out: value("--out"),
    from: value("--from"),
    baseline: value("--baseline"),
    format: value("--format") === "text" ? "text" : "json",
    moves: argv.includes("--moves"),
  };
}

const runScan = (options: ScanOptions): Effect.Effect<import("./scan.js").ScanReport, never, never> => scan(options);

/**
 * Fail closed: a truncated scan is PARTIAL, so any negative it produces
 * ("not found", "missing") would be a silent lie. Refuse to answer from
 * partial data — the reason goes to stderr, the exit code is 2.
 */
function refuseTruncated(truncated: boolean, command: string): void {
  if (!truncated) return;
  process.stderr.write(
    `toolscan ${command}: scan was truncated (budget exceeded) — the result is partial and cannot answer this question. Raise --max-files/--max-ms and re-run.\n`,
  );
  process.exit(2);
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function textLines(tools: readonly { name: string; path: string; source: string }[]): string {
  return tools.map((t) => `${t.name}\t${t.path}\t${t.source}`).join("\n");
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (!args) return;

  switch (args.command) {
    case "list": {
      const report = await Effect.runPromise(runScan(args.scanOptions));
      for (const t of report.tools) console.log(t.name);
      process.exit(report.truncated ? 2 : 0);
      break;
    }
    case "check": {
      const name = args.positional[0];
      if (!name) {
        usage();
        process.exit(2);
      }
      const report = await Effect.runPromise(runScan(args.scanOptions));
      refuseTruncated(report.truncated, "check");
      const found = report.tools.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (found) {
        console.log(found.path);
        process.exit(0);
      }
      if (!args.quiet) process.stderr.write(`not found: ${name}\n`);
      process.exit(1);
      break;
    }
    case "snapshot": {
      const report = await Effect.runPromise(runScan(args.scanOptions));
      const file = args.out || path.join(process.cwd(), "toolscan-snapshot.json");
      writeSnapshot(file, snapshotFrom(report, process.platform));
      if (!args.quiet) console.log(file);
      process.exit(report.truncated ? 2 : 0);
      break;
    }
    case "diff": {
      const [aFile, bFile] = args.positional;
      if (!aFile) {
        usage();
        process.exit(2);
      }
      let b: readonly import("./scan.js").ToolEntry[];
      if (bFile) {
        b = loadSnapshot(bFile).tools;
      } else {
        b = (await Effect.runPromise(runScan(args.scanOptions))).tools;
      }
      const out = diffTools(loadSnapshot(aFile).tools, b, { moves: args.moves });
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
      break;
    }
    case "missing": {
      if (!args.from) {
        usage();
        process.exit(2);
      }
      const names = fs
        .readFileSync(args.from, "utf8")
        .split(/[\s,]+/)
        .filter(Boolean);
      const report = await Effect.runPromise(runScan(args.scanOptions));
      refuseTruncated(report.truncated, "missing");
      const have = new Set(report.tools.map((t) => t.name.toLowerCase()));
      const missing = names.filter((n) => !have.has(n.toLowerCase()));
      const out = { ok: missing.length === 0, missing };
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
      break;
    }
    case "drift": {
      if (!args.baseline) {
        usage();
        process.exit(2);
      }
      let baseline;
      try {
        baseline = loadSnapshot(args.baseline);
      } catch (err) {
        fail(`drift: cannot read baseline ${args.baseline}: ${(err as Error).message}`, 1);
      }
      const report = await Effect.runPromise(runScan(args.scanOptions));
      // A truncated scan must not become the new baseline: it would poison
      // every future comparison. Report the drift honestly and keep the old
      // baseline untouched.
      if (report.truncated) {
        console.log(JSON.stringify({ ok: false, truncated: true, added: [], removed: [], changed: [], moved: [] }, null, 2));
        process.exit(2);
      }
      const out = diffTools(baseline.tools, report.tools, { moves: args.moves });
      const next = snapshotFrom(report, process.platform);
      writeSnapshot(args.out || args.baseline, next);
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
      break;
    }
    case "doctor": {
      const report = await Effect.runPromise(runDoctor(args.scanOptions));
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.ok ? 0 : report.truncated ? 2 : 1);
      break;
    }
    case "scan":
    default: {
      const report = await Effect.runPromise(runScan(args.scanOptions));
      if (args.quiet) {
        for (const t of report.tools) console.log(t.name);
      } else if (args.format === "text") {
        console.log(textLines(report.tools));
      } else {
        const out = {
          ok: true,
          elapsedMs: report.elapsedMs,
          truncated: report.truncated,
          pathEntries: report.pathEntries,
          tools: report.tools,
        };
        // Fail closed before emission: the JSON contract is load-bearing
        // for downstream consumers. A malformed report is an error with the
        // reason — never a silent malformed payload.
        const violations = validateScanReport(out);
        if (violations.length > 0) {
          fail(`toolscan scan: internal contract violation: ${violations.join("; ")}`, 1);
        }
        console.log(JSON.stringify(out, null, 2));
      }
      process.exit(report.truncated ? 2 : 0);
      break;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`toolscan: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});