#!/usr/bin/env node
// toolscan — cross-platform tool discovery: PATH + XDG + common dirs.
// Zero dependencies. Lineage: the bounded, truthful discovery-walker discipline
// extracted from WEP (Alot1z/windows-environment-paths) — same noise rules,
// same bounded scan, truthful `truncated` reporting. Nothing Windows-specific
// or PATH-manager-related was carried over; this is a read-only scanner.
//
// Commands:
//   toolscan                       scan PATH + roots, JSON to stdout
//   toolscan list                  names only, one per line
//   toolscan snapshot [--out F]    save a snapshot (default ./toolscan-snapshot.json)
//   toolscan diff A.json [B.json]  added/removed/changed; exit 1 when different
//   toolscan check <name>          print resolved path; exit 0 found / 1 not
//   toolscan missing --from F      report names (newline/comma list) not found
//
// Shared flags: --name GLOB --roots A,B --no-path --depth N --max-ms N
//               --max-files N --quiet --version
import fs from 'node:fs';
import path from 'node:path';

const SKIP_NAMES = new Set(['.git', 'node_modules', '.cache', '__pycache__',
  'cache', 'caches', 'logs', 'Temp', 'tmp', '$Recycle.Bin', 'System Volume Information']);

function isWin() { return process.platform === 'win32'; }

function extSet() {
  if (!isWin()) return null;
  return new Set((process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((e) => e.trim().toLowerCase()).filter(Boolean));
}
function isExecutable(file, ex) {
  if (ex) return ex.has(path.extname(file).toLowerCase());
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}
function toolName(file, ex) {
  const base = path.basename(file);
  if (!ex) return base;
  const ext = path.extname(base).toLowerCase();
  return ex.has(ext) ? base.slice(0, -ext.length) : base;
}

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

// One scan: PATH first (authoritative, first-hit-wins), then roots.
function scan(opts) {
  const ex = extSet();
  const started = Date.now();
  const budget = { maxMs: opts.maxMs, maxFiles: opts.maxFiles, maxDepth: opts.depth, files: 0, truncated: false };
  const filter = nameFilter(opts.name);
  const tools = new Map();
  let pathEntries = 0;
  if (!opts.noPath) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir || Date.now() - started > budget.maxMs) { if (dir) budget.truncated = true; break; }
      pathEntries++;
      scanDir(dir, ex, budget, (name, full) => {
        if (!tools.has(name) && filter(name)) tools.set(name, { name, path: full, source: 'PATH' });
      });
    }
  }
  if (Date.now() - started <= budget.maxMs) {
    const roots = (opts.roots ? opts.roots.split(',') : defaultRoots())
      .map((r) => r.replace(/^~(?=[\\/])/, process.env.HOME || process.env.USERPROFILE || '~'))
      .filter(Boolean);
    for (const [name, t] of scanRoots(roots, ex, budget)) {
      if (!tools.has(name) && filter(name)) tools.set(name, t);
    }
  }
  return {
    tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
    truncated: budget.truncated,
    elapsedMs: Date.now() - started,
    pathEntries,
  };
}

function usage() {
  console.error(`toolscan — discover tools on PATH, XDG and common dirs (JSON out)

Commands:
  toolscan                       scan PATH + roots, JSON to stdout
  toolscan list                  names only, one per line
  toolscan snapshot [--out F]    save a snapshot (default ./toolscan-snapshot.json)
  toolscan diff A.json [B.json]  compare snapshots (or a snapshot vs a live scan);
                                 exit 1 when tools were added, removed or moved
  toolscan check <name>          print the resolved path; exit 0 found / 1 not
  toolscan missing --from F      read a name list (newline or comma) and report
                                 which are not found; exit 1 when any are missing

Flags: --name GLOB --roots A,B --no-path --depth N --max-ms N --max-files N
       --quiet --version
`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { usage(); process.exit(0); }
if (args.includes('--version')) { console.log('toolscan 1.1.0'); process.exit(0); }

// First non-flag token is the command (scan is the default).
let cmd = 'scan';
const positional = [];
for (const a of args) {
  if (a.startsWith('-')) continue;
  if (cmd === 'scan' && ['list', 'snapshot', 'diff', 'check', 'missing'].includes(a)) cmd = a;
  else positional.push(a);
}
const ai = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const opts = {
  name: ai('--name'),
  roots: ai('--roots'),
  noPath: args.includes('--no-path'),
  depth: Number(ai('--depth')) || 2,
  maxMs: Number(ai('--max-ms')) || 8000,
  maxFiles: Number(ai('--max-files')) || 20000,
  quiet: args.includes('--quiet'),
  out: ai('--out'),
  from: ai('--from'),
};

if (cmd === 'list') {
  const r = scan(opts);
  for (const t of r.tools) console.log(t.name);
  process.exit(r.truncated ? 2 : 0);
}

if (cmd === 'snapshot') {
  const r = scan(opts);
  const snap = {
    format: 'toolscan-snapshot/1',
    date: new Date().toISOString(),
    platform: process.platform,
    truncated: r.truncated,
    pathEntries: r.pathEntries,
    tools: r.tools,
  };
  const file = opts.out || path.join(process.cwd(), 'toolscan-snapshot.json');
  fs.writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');
  if (!opts.quiet) console.log(file);
  process.exit(r.truncated ? 2 : 0);
}

if (cmd === 'diff') {
  const [aFile, bFile] = positional;
  if (!aFile) { usage(); process.exit(2); }
  const load = (f) => {
    if (!f) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8')).tools || [];
  };
  const a = new Map(load(aFile).map((t) => [t.name, t.path]));
  const bRaw = bFile ? load(bFile) : scan(opts).tools;
  const b = new Map(bRaw.map((t) => [t.name, t.path]));
  const added = [], removed = [], changed = [];
  for (const [name, p] of b) if (!a.has(name)) added.push({ name, path: p });
  for (const [name, p] of a) if (!b.has(name)) removed.push({ name, path: p });
  for (const [name, p] of b) if (a.has(name) && a.get(name) !== p) changed.push({ name, from: a.get(name), to: p });
  const out = { ok: added.length + removed.length + changed.length === 0, added, removed, changed };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

if (cmd === 'check') {
  const name = positional[0];
  if (!name) { usage(); process.exit(2); }
  const r = scan(opts);
  const t = r.tools.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (t) { console.log(t.path); process.exit(0); }
  if (!opts.quiet) console.error(`not found: ${name}`);
  process.exit(1);
}

if (cmd === 'missing') {
  if (!opts.from) { usage(); process.exit(2); }
  const names = fs.readFileSync(opts.from, 'utf8').split(/[\s,]+/).filter(Boolean);
  const r = scan(opts);
  const have = new Set(r.tools.map((t) => t.name.toLowerCase()));
  const missing = names.filter((n) => !have.has(n.toLowerCase()));
  const out = { ok: missing.length === 0, missing };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

// Default: scan to stdout.
const r = scan(opts);
const out = {
  ok: true,
  elapsedMs: r.elapsedMs,
  truncated: r.truncated,
  pathEntries: r.pathEntries,
  tools: r.tools,
};
if (opts.quiet) { for (const t of r.tools) console.log(t.name); }
else console.log(JSON.stringify(out, null, 2));
process.exit(r.truncated ? 2 : 0);