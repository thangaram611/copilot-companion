import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, lstatSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import {
  socketPath,
  queuePath,
  eventsPath,
  runtimeDirPath,
  ensureRuntimeDir,
  daemonLogPath,
  namespaceTag,
  SECURE_FILE_MODE,
} from './paths.mjs';

const SAMPLE_UUID = '550e8400-e29b-41d4-a716-446655440000';

// ───── per-test runtime base ─────
//
// Most tests need an isolated runtime base so they don't fight over the
// real /tmp/copilot-companion-<ns>/ dir. Use COPILOT_RUNTIME_BASE to
// point ensureRuntimeDir at a per-test mkdtemp dir.

let isolatedBase;
let _baseBefore;
function setIsolatedBase() {
  // Save the prior value so tests don't destroy a runner-set
  // COPILOT_RUNTIME_BASE — matters when the suite runs inside a
  // containerized base or when a developer has the var exported.
  _baseBefore = process.env.COPILOT_RUNTIME_BASE;
  isolatedBase = mkdtempSync(join(tmpdir(), 'paths-test-'));
  process.env.COPILOT_RUNTIME_BASE = isolatedBase;
}
function teardownIsolatedBase() {
  if (_baseBefore === undefined) delete process.env.COPILOT_RUNTIME_BASE;
  else process.env.COPILOT_RUNTIME_BASE = _baseBefore;
  if (isolatedBase) {
    try { rmSync(isolatedBase, { recursive: true, force: true }); } catch {}
    isolatedBase = null;
  }
}

// ─── namespace ────────────────────────────────────────────────────────

test('namespaceTag is non-empty and stable across calls', () => {
  const a = namespaceTag();
  const b = namespaceTag();
  assert.equal(a, b);
  assert.ok(a.length > 0);
  assert.match(a, /^(uid\d+|user-[A-Za-z0-9._-]+|shared)$/);
});

// ─── path getters (pure, no side effects) ─────────────────────────────

test('runtimeDirPath embeds plugin name and namespace', () => {
  setIsolatedBase();
  try {
    const p = runtimeDirPath();
    assert.ok(p.startsWith(isolatedBase), `expected ${p} under ${isolatedBase}`);
    assert.ok(p.includes(`copilot-companion-${namespaceTag()}`));
  } finally {
    teardownIsolatedBase();
  }
});

test('socketPath lives inside the runtime dir', () => {
  const before = process.env.COPILOT_SOCKET_PATH;
  delete process.env.COPILOT_SOCKET_PATH;
  setIsolatedBase();
  try {
    const p = socketPath();
    assert.ok(p.startsWith(runtimeDirPath()));
    assert.ok(p.endsWith('/daemon.sock'));
  } finally {
    teardownIsolatedBase();
    if (before !== undefined) process.env.COPILOT_SOCKET_PATH = before;
  }
});

test('queuePath lives inside the runtime dir', () => {
  const before = process.env.COPILOT_QUEUE_PATH;
  delete process.env.COPILOT_QUEUE_PATH;
  setIsolatedBase();
  try {
    const p = queuePath();
    assert.ok(p.startsWith(runtimeDirPath()));
    assert.ok(p.endsWith('/completions.jsonl'));
  } finally {
    teardownIsolatedBase();
    if (before !== undefined) process.env.COPILOT_QUEUE_PATH = before;
  }
});

test('eventsPath lives inside the runtime dir and embeds promptId', () => {
  setIsolatedBase();
  try {
    const p = eventsPath(SAMPLE_UUID);
    assert.ok(p.startsWith(runtimeDirPath()));
    assert.ok(p.includes(SAMPLE_UUID));
    assert.ok(p.endsWith('.jsonl'));
  } finally {
    teardownIsolatedBase();
  }
});

test('eventsPath rejects falsy or non-string promptId', () => {
  assert.throws(() => eventsPath(''), TypeError);
  assert.throws(() => eventsPath(null), TypeError);
  assert.throws(() => eventsPath(undefined), TypeError);
  assert.throws(() => eventsPath(42), TypeError);
});

test('eventsPath rejects path-traversal in promptId', () => {
  assert.throws(() => eventsPath('../etc/passwd'), TypeError);
  assert.throws(() => eventsPath('..'), TypeError);
  assert.throws(() => eventsPath('foo/bar'), TypeError);
  assert.throws(() => eventsPath('foo\\bar'), TypeError);
  assert.throws(() => eventsPath('abc-123'), TypeError);
  assert.throws(() => eventsPath(SAMPLE_UUID + '\n../escape'), TypeError);
});

test('eventsPath accepts uppercase UUID variants', () => {
  setIsolatedBase();
  try {
    const upper = SAMPLE_UUID.toUpperCase();
    assert.ok(eventsPath(upper).includes(upper));
  } finally {
    teardownIsolatedBase();
  }
});

test('COPILOT_QUEUE_PATH override wins over computed path', () => {
  const before = process.env.COPILOT_QUEUE_PATH;
  process.env.COPILOT_QUEUE_PATH = '/var/tmp/test-override.jsonl';
  try {
    assert.equal(queuePath(), '/var/tmp/test-override.jsonl');
  } finally {
    if (before === undefined) delete process.env.COPILOT_QUEUE_PATH;
    else process.env.COPILOT_QUEUE_PATH = before;
  }
});

test('COPILOT_SOCKET_PATH override wins over computed path', () => {
  const before = process.env.COPILOT_SOCKET_PATH;
  process.env.COPILOT_SOCKET_PATH = '/var/tmp/test.sock';
  try {
    assert.equal(socketPath(), '/var/tmp/test.sock');
  } finally {
    if (before === undefined) delete process.env.COPILOT_SOCKET_PATH;
    else process.env.COPILOT_SOCKET_PATH = before;
  }
});

test('SECURE_FILE_MODE is 0o600', () => {
  assert.equal(SECURE_FILE_MODE, 0o600);
});

test('daemonLogPath lives inside the runtime dir', () => {
  setIsolatedBase();
  try {
    const p = daemonLogPath();
    assert.ok(p.startsWith(runtimeDirPath()));
    assert.ok(p.endsWith('/daemon.log'));
  } finally {
    teardownIsolatedBase();
  }
});

test('whitespace-only and control-char env values are rejected', () => {
  // envOverride() rejects strings that would silently misconfigure paths
  // — common when CI uses $(cat file) and the file has a trailing newline.
  const beforeBase = process.env.COPILOT_RUNTIME_BASE;
  // Test trailing newline (common from $(cat file))
  process.env.COPILOT_RUNTIME_BASE = '/tmp/foo\n';
  try {
    assert.ok(runtimeDirPath().startsWith(tmpdir()),
      'newline in override must fall through to default');
  } finally {
    if (beforeBase === undefined) delete process.env.COPILOT_RUNTIME_BASE;
    else process.env.COPILOT_RUNTIME_BASE = beforeBase;
  }
  // Whitespace-only
  process.env.COPILOT_RUNTIME_BASE = '   ';
  try {
    assert.ok(runtimeDirPath().startsWith(tmpdir()),
      'whitespace-only override must fall through to default');
  } finally {
    if (beforeBase === undefined) delete process.env.COPILOT_RUNTIME_BASE;
    else process.env.COPILOT_RUNTIME_BASE = beforeBase;
  }
});

test('XDG_RUNTIME_DIR empty string falls through to tmpdir', { skip: typeof process.getuid !== 'function' || process.getuid() === 0 }, () => {
  // Linux desktops where systemd --user fails to set XDG_RUNTIME_DIR
  // sometimes export it as empty rather than unset. Without the
  // empty-handling in envOverride(), this would silently route prompt
  // content to cwd via path.join('', ...).
  const beforeBase = process.env.COPILOT_RUNTIME_BASE;
  const beforeXdg = process.env.XDG_RUNTIME_DIR;
  delete process.env.COPILOT_RUNTIME_BASE;
  process.env.XDG_RUNTIME_DIR = '';
  try {
    const p = runtimeDirPath();
    assert.ok(p.startsWith(tmpdir()),
      `empty XDG_RUNTIME_DIR must fall through to tmpdir, got ${p}`);
  } finally {
    if (beforeBase === undefined) delete process.env.COPILOT_RUNTIME_BASE;
    else process.env.COPILOT_RUNTIME_BASE = beforeBase;
    if (beforeXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = beforeXdg;
  }
});

test('empty-string env override falls through to default (not literally empty)', () => {
  // envOverride() helper treats '' as unset to avoid silent test misconfig
  // where an exported-but-empty var resolves to a relative path.
  const beforeBase = process.env.COPILOT_RUNTIME_BASE;
  const beforeQueue = process.env.COPILOT_QUEUE_PATH;
  const beforeSocket = process.env.COPILOT_SOCKET_PATH;
  process.env.COPILOT_RUNTIME_BASE = '';
  process.env.COPILOT_QUEUE_PATH = '';
  process.env.COPILOT_SOCKET_PATH = '';
  try {
    // All three should produce sensible defaults under tmpdir, NOT
    // anything starting with a literal '' (which would resolve to cwd).
    assert.ok(runtimeDirPath().startsWith(tmpdir()),
      `empty COPILOT_RUNTIME_BASE must fall through to tmpdir, got ${runtimeDirPath()}`);
    assert.ok(queuePath().startsWith(tmpdir()),
      `empty COPILOT_QUEUE_PATH must fall through, got ${queuePath()}`);
    assert.ok(socketPath().startsWith(tmpdir()),
      `empty COPILOT_SOCKET_PATH must fall through, got ${socketPath()}`);
  } finally {
    if (beforeBase === undefined) delete process.env.COPILOT_RUNTIME_BASE;
    else process.env.COPILOT_RUNTIME_BASE = beforeBase;
    if (beforeQueue === undefined) delete process.env.COPILOT_QUEUE_PATH;
    else process.env.COPILOT_QUEUE_PATH = beforeQueue;
    if (beforeSocket === undefined) delete process.env.COPILOT_SOCKET_PATH;
    else process.env.COPILOT_SOCKET_PATH = beforeSocket;
  }
});

// ───── ensureRuntimeDir — the security guarantee ─────────────────────
//
// These tests exercise the function YOU implement in lib/paths.mjs.
// Until the TODO block is filled in, they will all fail — that's the
// red part of red-green-refactor. Once your implementation is in,
// they should all go green.

test('ensureRuntimeDir creates the dir when absent', () => {
  setIsolatedBase();
  try {
    const dir = ensureRuntimeDir();
    const st = lstatSync(dir);
    assert.ok(st.isDirectory(), 'returned path must be a directory');
    assert.equal(dir, runtimeDirPath());
  } finally {
    teardownIsolatedBase();
  }
});

test('ensureRuntimeDir creates the dir with mode 0o700', () => {
  setIsolatedBase();
  try {
    const dir = ensureRuntimeDir();
    const st = lstatSync(dir);
    // Mask off file-type bits; mode bits should be exactly 0o700.
    assert.equal(st.mode & 0o777, 0o700, `expected 0o700, got ${(st.mode & 0o777).toString(8)}`);
  } finally {
    teardownIsolatedBase();
  }
});

test('ensureRuntimeDir is idempotent', () => {
  setIsolatedBase();
  try {
    const a = ensureRuntimeDir();
    const b = ensureRuntimeDir();
    assert.equal(a, b);
    // Still a directory after second call (no replacement, no errors).
    assert.ok(lstatSync(a).isDirectory());
  } finally {
    teardownIsolatedBase();
  }
});

test('ensureRuntimeDir rejects pre-existing dir with group/world bits', { skip: typeof process.getuid !== 'function' }, () => {
  setIsolatedBase();
  try {
    // Pre-create the dir we own with mode 0o755 (world-readable). Owner
    // uid matches, but the mode check must reject it. Tests invariant 3.
    const dir = runtimeDirPath();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755); // umask can dilute the mkdir mode; force it
    assert.throws(
      () => ensureRuntimeDir(),
      (err) => err instanceof Error && err.message.includes(dir),
      'must throw with the offending path in the message',
    );
  } finally {
    teardownIsolatedBase();
  }
});

test('ensureRuntimeDir rejects symlink at the dir path', { skip: typeof process.getuid !== 'function' }, () => {
  setIsolatedBase();
  try {
    // Plant a symlink where the runtime dir should be. lstat must catch
    // this — it doesn't follow symlinks. Tests invariant 1.
    const target = mkdtempSync(join(tmpdir(), 'paths-test-target-'));
    try {
      symlinkSync(target, runtimeDirPath());
      assert.throws(
        () => ensureRuntimeDir(),
        (err) => err instanceof Error && err.message.includes(runtimeDirPath()),
        'must throw with the offending path in the message',
      );
    } finally {
      try { rmSync(target, { recursive: true, force: true }); } catch {}
    }
  } finally {
    teardownIsolatedBase();
  }
});

test('ensureRuntimeDir succeeds against a pre-existing correct dir', { skip: typeof process.getuid !== 'function' }, () => {
  setIsolatedBase();
  try {
    // Pre-create with the exact correct mode. Function should accept it.
    const dir = runtimeDirPath();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // belt-and-suspenders against umask
    assert.equal(ensureRuntimeDir(), dir);
  } finally {
    teardownIsolatedBase();
  }
});
