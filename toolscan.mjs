#!/usr/bin/env node
// toolscan — cross-platform tool discovery: PATH + XDG + common dirs, JSON out.
// Zero dependencies. Lineage: the bounded, truthful discovery-walker discipline
// extracted from WEP (Alot1z/windows-environment-paths) — same noise rules,
// same bounded scan, truthful `truncated` reporting. Nothing Windows-specific
// or PATH-manager-related was carried over; this is a read-only scanner.
import fs from 'node:fs';
import path from 'node:path';

const SKIP_NAMES = new Set(['.git', 'node_modules', '.cache', '__pycache__',
  'cache', 'caches', 'logs', 'Temp', 'tmp', '$Recycle.Bin', 'System Volume Information']);

function isWin() { return process.platform === 'win32'; }

// Executable definition: PATHEXT extensions on Windows, X_OK bit on POSIX.
function extSet() {
  if (!isWin()) return null;
  return new Set((process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((e) => e.trim().toLowerCase()).filter(Boolean));
}
function isExecutable(file, ex) {
  if (ex) return ex.has(path.extname(file).toLowerCase());
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

// Bare tool name: strip a known executable extension so `git.exe` and
// `git.cmd` are the same tool (first PATH hit wins). POSIX keeps basename.
function toolName(file, ex) {
  const base = path.basename(file);
  if (!ex) return base;
  const ext = path.extname(base).toLowerCase();
  return ex.has(ext) ? base.slice(0, -ext.length) : base;
}

// Common tool homes, platform-ordered (earlier = higher priority).
function defaultRoots() {
  const h = process.env.HOME || process.env.USERPROFILE || '';
  const p = [];
  if (process.env.XDG_BIN_HOME) p.push(process.env.XDG_BIN_HOME);
  if (process.env.XDG_DATA_HOME) p.push(path.join(process.env.XDG_DATA_HOME, 'bin'));
  if (process.env.XDG_CONFIG_HOME) p.push(path.join(process.env.XDG_CONFIG_HOME, 'bin'));
  if (h) p.push(path.join(h, '.local', 'bin'), path.join(h, 'bin'), path.join(h, '.cargo', 'bin'),
    path.join(h, 'go', 'bin'), path.join(h, '.npm-global', 'bin'), path.join(h, '.yarn', 'bin'),
    path.join(h, '.bun', 'bin'), path.join(h, '.deno', 'bin'));
  if (isWin()) {
    if (process.env.LOCALAPPDATA) p.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
    if (process.env.APPDATA) p.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.ProgramFiles) p.push(process.env.ProgramFiles);
    if (process.env['ProgramFiles(x86)']) p.push(process.env['ProgramFiles(x86)']);
  } else {
    for (const d of (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')) {
      if (d) p.push(path.join(d, 'bin'));
    }
    p.push('/usr/local/bin', '/usr/local/sbin', '/opt/homebrew/bin', '/opt/bin');
  }
  return [...new Set(p)];
}

// Scan one directory's direct file children for executables.
function scanDir(dir, ex, budget, sink) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (budget.files > budget.maxFiles) { budget.truncated = true; return; }
    budget.files++;
    if (it.isDirectory() || it.isSymbolicLink()) continue;
    const full = path.join(dir, it.name);
    if (isExecutable(full, ex)) sink(toolName(full, ex), full);
  }
}

// Bounded BFS over roots: dirs containing executables, files at depth <= maxDepth.
function scanRoots(roots, ex, budget) {
  const tools = new Map();
  for (const root of roots) {
    const queue = [[root, 0]];
    while (queue.length) {
      if (budget.truncated) return tools;
      const [dir, depth] = queue.shift();
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const it of items) {
        if (budget.files > budget.maxFiles) { budget.truncated = true; break; }
        budget.files++;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          if (depth >= budget.maxDepth || SKIP_NAMES.has(it.name)) continue;
          if (it.isSymbolicLink()) continue;
          try { if (fs.lstatSync(full).isSymbolicLink()) continue; } catch { continue; }
          queue.push([full, depth + 1]);
        } else if (!tools.has(toolName(full, ex)) && isExecutable(full, ex)) {
          const n = toolName(full, ex);
          tools.set(n, { name: n, path: full, source: 'root' });
        }
      }
    }
  }
  return tools;
}

function nameFilter(pattern) {
  if (!pattern) return () => true;
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$', 'i');
  return (n) => re.test(n);
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function usage() {
  console.error(`toolscan — discover tools on PATH, XDG and common dirs (JSON out)

Usage: toolscan [--name GLOB] [--roots A,B] [--no-path] [--depth N]
                [--max-ms N] [--max-files N] [--quiet]

  --name GLOB    filter tools by name (* wildcards, case-insensitive)
  --roots A,B    extra roots to scan (default: XDG + platform common dirs)
  --no-path      skip the PATH scan
  --depth N      root BFS depth (default 2)
  --max-ms N     wall-clock budget (default 8000)
  --max-files N  file budget (default 20000)
  --quiet        names only, one per line
  --version      print version
`);
}

const args = process.argv.slice(2);
const ai = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--help') || args.includes('-h')) { usage(); process.exit(0); }
if (args.includes('--version')) { console.log('toolscan 1.0.0'); process.exit(0); }

const ex = extSet();
const budget = {
  maxMs: Number(ai('--max-ms')) || 8000,
  maxFiles: Number(ai('--max-files')) || 20000,
  maxDepth: Number(ai('--depth')) || 2,
  files: 0,
  truncated: false,
};
const filter = nameFilter(ai('--name'));
const started = Date.now();

// 1. PATH scan — first hit per name wins (PATH priority semantics).
const tools = new Map();
let pathEntries = 0;
if (!args.includes('--no-path')) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || Date.now() - started > budget.maxMs) { if (dir) budget.truncated = true; break; }
    pathEntries++;
    scanDir(dir, ex, budget, (name, full) => {
      if (!tools.has(name) && filter(name)) tools.set(name, { name, path: full, source: 'PATH' });
    });
  }
}

// 2. Root scan — XDG + common dirs (PATH stays authoritative for dup names).
if (!budget.truncated || Date.now() - started <= budget.maxMs) {
  const roots = (ai('--roots') ? ai('--roots').split(',') : defaultRoots())
    .map((r) => r.replace(/^~(?=[\\/])/, process.env.HOME || process.env.USERPROFILE || '~'))
    .filter(Boolean);
  for (const [name, t] of scanRoots(roots, ex, budget)) {
    if (!tools.has(name) && filter(name)) tools.set(name, t);
  }
}

const out = {
  ok: true,
  elapsedMs: Date.now() - started,
  truncated: budget.truncated,
  pathEntries,
  tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
};
if (args.includes('--quiet')) {
  for (const t of out.tools) console.log(t.name);
} else {
  console.log(JSON.stringify(out, null, 2));
}
process.exit(out.truncated ? 2 : 0);