// Hermetic tests: temp-dir fixtures only, never touches the real PATH state
// beyond what each test sets for its own child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./toolscan.mjs', import.meta.url));
const isWin = process.platform === 'win32';

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'toolscan-test-')); }

// Create an executable-bearing file: .cmd on Windows, chmod +x on POSIX.
function mkTool(dir, name) {
  const f = isWin ? `${name}.cmd` : name;
  fs.writeFileSync(path.join(dir, f), isWin ? '@echo off\n' : '#!/bin/sh\n');
  if (!isWin) fs.chmodSync(path.join(dir, f), 0o755);
  return f;
}

// Prepend dirs to PATH rather than replacing it: node itself needs system dirs
// on PATH on Windows, so a bare temp-dir PATH breaks the harness, not the tool.
function withPath(...dirs) {
  return { ...process.env, PATH: [...dirs, process.env.PATH].filter(Boolean).join(path.delimiter) };
}

function run(args, env) {
  try {
    return { rc: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' }) };
  } catch (e) {
    return { rc: e.status ?? 1, out: e.stdout ?? '' };
  }
}

test('PATH scan finds a tool in a temp dir', () => {
  const d = tmpdir();
  const f = mkTool(d, 'fake-a');
  const r = run(['--quiet'], withPath(d));
  assert.equal(r.rc, 0);
  assert.ok(r.out.split('\n').includes(isWin ? 'fake-a' : 'fake-a'), 'tool name present');
  const j = JSON.parse(run([], withPath(d)).out);
  const t = j.tools.find((x) => x.name === 'fake-a');
  assert.ok(t, 'tool in JSON');
  assert.equal(t.source, 'PATH');
  assert.ok(t.path.endsWith(f));
});

test('first hit wins across PATH entries (PATH priority)', () => {
  const d1 = tmpdir(), d2 = tmpdir();
  mkTool(d1, 'dup-tool');
  mkTool(d2, 'dup-tool');
  const j = JSON.parse(run([], withPath(d1, d2)).out);
  const t = j.tools.find((x) => x.name === 'dup-tool');
  assert.ok(t.path.startsWith(d1), `expected ${d1}, got ${t.path}`);
});

test('root scan adds tools not on PATH; PATH stays authoritative', () => {
  const root = tmpdir();
  mkTool(root, 'root-tool');
  const j = JSON.parse(run(['--roots', root, '--depth', '1', '--no-path'], { ...process.env }).out);
  const t = j.tools.find((x) => x.name === 'root-tool');
  assert.ok(t, 'root tool found');
  assert.equal(t.source, 'root');
  assert.ok(t.path.startsWith(root));
});

test('--name filter narrows results', () => {
  const d = tmpdir();
  mkTool(d, 'want-this');
  mkTool(d, 'other');
  const r = run(['--name', 'want-*'], withPath(d));
  const j = JSON.parse(r.out);
  assert.deepEqual(j.tools.map((t) => t.name), ['want-this']);
});

test('truncation is truthful: tiny budget sets truncated + rc 2', () => {
  const d = tmpdir();
  for (let i = 0; i < 5; i++) mkTool(d, `many-${i}`);
  const r = run(['--max-files', '1'], withPath(d));
  assert.equal(r.rc, 2);
  const j = JSON.parse(r.out);
  assert.equal(j.truncated, true);
});

test('missing PATH dirs are skipped gracefully', () => {
  const r = run(['--no-path', '--roots', path.join(tmpdir(), 'does-not-exist')], { ...process.env });
  assert.equal(r.rc, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.truncated, false);
  assert.deepEqual(j.tools, []);
});

test('deep root walk respects --depth (no files beyond it)', () => {
  const root = tmpdir();
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  mkTool(deep, 'deep-tool');
  const j = JSON.parse(run(['--roots', root, '--depth', '1', '--no-path'], { ...process.env }).out);
  assert.ok(!j.tools.some((t) => t.name === 'deep-tool'), 'beyond depth not found');
  const j2 = JSON.parse(run(['--roots', root, '--depth', '2', '--no-path'], { ...process.env }).out);
  assert.ok(j2.tools.some((t) => t.name === 'deep-tool'), 'within depth found');
});

test('--quiet prints names only', () => {
  const d = tmpdir();
  mkTool(d, 'quiet-tool');
  const r = run(['--quiet'], withPath(d));
  assert.equal(r.rc, 0);
  const names = r.out.trim().split('\n');
  assert.ok(names.includes('quiet-tool'));
  assert.ok(!r.out.includes('"ok"'), 'not JSON');
});

test('snapshot writes a loadable file', () => {
  const d = tmpdir();
  mkTool(d, 'snap-tool');
  const out = path.join(tmpdir(), 'snap.json');
  const r = run(['snapshot', '--out', out], withPath(d));
  assert.equal(r.rc, 0);
  const snap = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(snap.format, 'toolscan-snapshot/1');
  assert.ok(snap.tools.some((t) => t.name === 'snap-tool'));
});

test('diff reports added/removed/changed and exits 1', () => {
  const d1 = tmpdir(), d2 = tmpdir();
  mkTool(d1, 'gone-tool');
  mkTool(d1, 'shared-tool'); // exists in a at d1; moved to d2 before b
  const a = path.join(tmpdir(), 'a.json');
  assert.equal(run(['snapshot', '--out', a], withPath(d1)).rc, 0);
  mkTool(d2, 'new-tool');
  fs.rmSync(path.join(d1, isWin ? 'gone-tool.cmd' : 'gone-tool')); // gone in b
  fs.renameSync(
    path.join(d1, isWin ? 'shared-tool.cmd' : 'shared-tool'),
    path.join(d2, isWin ? 'shared-tool.cmd' : 'shared-tool')
  );
  const b = path.join(tmpdir(), 'b.json');
  assert.equal(run(['snapshot', '--out', b], withPath(d1, d2)).rc, 0);
  const r = run(['diff', a, b]);
  assert.equal(r.rc, 1, 'diff exits 1 when different');
  const j = JSON.parse(r.out);
  assert.ok(j.removed.some((t) => t.name === 'gone-tool'));
  assert.ok(j.added.some((t) => t.name === 'new-tool'));
  assert.ok(j.changed.some((t) => t.name === 'shared-tool'));
  // identical diff exits 0
  const r2 = run(['diff', a, a]);
  assert.equal(r2.rc, 0);
});

test('check resolves a tool and exits 0/1', () => {
  const d = tmpdir();
  mkTool(d, 'check-tool');
  const found = run(['check', 'check-tool'], withPath(d));
  assert.equal(found.rc, 0);
  assert.ok(found.out.trim().endsWith(isWin ? 'check-tool.cmd' : 'check-tool'));
  const notFound = run(['check', 'nope-none'], withPath(d));
  assert.equal(notFound.rc, 1);
});

test('missing reports absent names and exits 1; all-present exits 0', () => {
  const d = tmpdir();
  mkTool(d, 'have-tool');
  const manifest = path.join(tmpdir(), 'manifest.txt');
  fs.writeFileSync(manifest, 'have-tool, absent-one\nabsent-two\n');
  const r = run(['missing', '--from', manifest], withPath(d));
  assert.equal(r.rc, 1);
  assert.deepEqual(JSON.parse(r.out).missing, ['absent-one', 'absent-two']);
  const ok = run(['missing', '--from', manifest], withPath(d));
  fs.writeFileSync(manifest, 'have-tool\n');
  const r2 = run(['missing', '--from', manifest], withPath(d));
  assert.equal(r2.rc, 0);
  assert.equal(JSON.parse(r2.out).ok, true);
});