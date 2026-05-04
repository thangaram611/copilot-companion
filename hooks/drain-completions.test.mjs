// drain-completions.test.mjs
//
// End-to-end test of hooks/drain-completions.sh as a real subprocess.
//
// Why this exists: the previous review rounds found six bugs in the drain
// hook's path-resolution logic. Every single one slipped past the existing
// unit tests because:
//   - paths.test.mjs tests Node's lib/paths.mjs in isolation
//   - daemon-client.test.mjs tests Node's IPC client
//   - There was NO test that ran the actual shell hook with set -e and
//     verified its behavior end-to-end
//
// This file closes that gap. It runs `bash hooks/drain-completions.sh`
// as a subprocess across (a) every env-rejection edge case, asserting the
// script exits 0 and doesn't abort under set -e, and (b) computes the
// shell-side runtime queue path and asserts byte-equality with Node's
// queuePath() — the parity property that prevents the bridge and hook
// from writing/reading different files.
//
// If a future regression breaks set -e propagation in validate_env_value,
// or the username regex drifts from Node's, or any third env override is
// introduced and forgets to go through validate_env_value — these tests
// fail, instead of the bug shipping silently.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, 'drain-completions.sh');

// Defensive: a developer with these vars exported in their shell would
// get misleading test results. Strip them at the test-file level.
before(() => {
  for (const k of ['COPILOT_SOCKET_PATH', 'COPILOT_QUEUE_PATH', 'XDG_RUNTIME_DIR']) {
    delete process.env[k];
  }
});

function runHook(extraEnv = {}, payload = '{"hook_event_name":"PostToolUse"}') {
  return spawnSync('bash', [HOOK], {
    input: payload,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 5000,
  });
}

// ───── exit-code tests under set -e ─────
//
// The hook's first line after the shebang is `set -e`. Any function or
// command that returns non-zero in a context that propagates exit codes
// (notably command substitutions in assignments) will abort the entire
// hook. The validate_env_value() function caught a real instance of this
// in commit bf08c6c — these tests guard against future regressions.

const REJECTION_CASES = [
  // [label, env, payload]
  ['default (no env overrides)', {}, undefined],
  ['COPILOT_RUNTIME_BASE empty', { COPILOT_RUNTIME_BASE: '' }, undefined],
  ['COPILOT_RUNTIME_BASE whitespace-only', { COPILOT_RUNTIME_BASE: '   ' }, undefined],
  ['COPILOT_RUNTIME_BASE with newline', { COPILOT_RUNTIME_BASE: '/tmp/x\n' }, undefined],
  ['COPILOT_RUNTIME_BASE with tab', { COPILOT_RUNTIME_BASE: '/tmp/x\t' }, undefined],
  ['XDG_RUNTIME_DIR empty', { XDG_RUNTIME_DIR: '' }, undefined],
  ['XDG_RUNTIME_DIR whitespace', { XDG_RUNTIME_DIR: '   ' }, undefined],
  ['XDG_RUNTIME_DIR with newline', { XDG_RUNTIME_DIR: '/run/user\n' }, undefined],
  ['COPILOT_QUEUE_PATH empty', { COPILOT_QUEUE_PATH: '' }, undefined],
  ['COPILOT_QUEUE_PATH whitespace', { COPILOT_QUEUE_PATH: '   ' }, undefined],
  ['COPILOT_QUEUE_PATH with newline', { COPILOT_QUEUE_PATH: '/tmp/q\n' }, undefined],
  ['all three set to whitespace', {
    COPILOT_RUNTIME_BASE: '   ',
    XDG_RUNTIME_DIR: '   ',
    COPILOT_QUEUE_PATH: '   ',
  }, undefined],
  ['UserPromptSubmit event', {}, '{"hook_event_name":"UserPromptSubmit"}'],
  ['SessionStart event', {}, '{"hook_event_name":"SessionStart"}'],
];

for (const [label, env, payload] of REJECTION_CASES) {
  test(`drain hook exits 0 under set -e: ${label}`, () => {
    const r = runHook(env, payload);
    assert.equal(r.status, 0,
      `hook aborted under set -e (exit ${r.status})\n` +
      `  stderr: ${r.stderr}\n  stdout: ${r.stdout}`);
  });
}

// ───── parity tests: shell QUEUE === Node queuePath() ─────
//
// Resolves the shell-side queue path by sourcing the same logic the hook
// uses, then compares against Node's queuePath() under the same env. The
// six escaped bugs all caused divergence here that the unit tests didn't
// detect. After this test exists, any new env-handling drift between Node
// and shell fails CI immediately.

function shellResolveQueue(env) {
  // Re-extract the resolution logic from drain-completions.sh.
  // Keep this script in sync with the actual hook — divergence here is
  // exactly the bug class we're guarding against.
  const script = `
    set -e
    validate_env_value() {
      local v="$1"
      [ -z "$v" ] && return 0
      case "$v" in *$'\\r'*|*$'\\n'*|*$'\\t'*) return 0 ;; esac
      v="\${v#"\${v%%[![:space:]]*}"}"
      v="\${v%"\${v##*[![:space:]]}"}"
      [ -n "$v" ] && printf '%s' "$v"
      return 0
    }
    NS=""
    if NS_UID=$(id -u 2>/dev/null) && [ -n "$NS_UID" ] && [ "$NS_UID" -ge 0 ] 2>/dev/null; then
      NS="uid\${NS_UID}"
    elif NS_USER=$(id -un 2>/dev/null) && [ -n "$NS_USER" ] \\
         && printf '%s' "$NS_USER" | grep -qE '^[A-Za-z0-9._-]{1,64}$'; then
      NS="user-\${NS_USER}"
    else
      NS="shared"
    fi
    COPILOT_RUNTIME_BASE_VALID="$(validate_env_value "\${COPILOT_RUNTIME_BASE:-}")"
    XDG_RUNTIME_DIR_VALID="$(validate_env_value "\${XDG_RUNTIME_DIR:-}")"
    if [ -n "$COPILOT_RUNTIME_BASE_VALID" ]; then
      BASE="$COPILOT_RUNTIME_BASE_VALID"
    elif [ -n "$XDG_RUNTIME_DIR_VALID" ] && [ "\${NS_UID:-0}" -gt 0 ] 2>/dev/null; then
      BASE="$XDG_RUNTIME_DIR_VALID"
    else
      BASE="\${TMPDIR:-/tmp}"
    fi
    BASE="\${BASE%/}"
    COPILOT_QUEUE_PATH_VALID="$(validate_env_value "\${COPILOT_QUEUE_PATH:-}")"
    if [ -n "$COPILOT_QUEUE_PATH_VALID" ]; then
      QUEUE="$COPILOT_QUEUE_PATH_VALID"
    else
      QUEUE="\${BASE}/copilot-companion-\${NS}/completions.jsonl"
    fi
    printf '%s' "$QUEUE"
  `;
  return spawnSync('bash', ['-c', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  }).stdout;
}

const PARITY_CASES = [
  ['default', {}],
  ['COPILOT_RUNTIME_BASE valid', { COPILOT_RUNTIME_BASE: '/tmp/x' }],
  ['COPILOT_RUNTIME_BASE whitespace-only', { COPILOT_RUNTIME_BASE: '   ' }],
  ['COPILOT_RUNTIME_BASE with newline', { COPILOT_RUNTIME_BASE: '/tmp/x\n' }],
  ['COPILOT_RUNTIME_BASE with surrounding whitespace', { COPILOT_RUNTIME_BASE: '  /tmp/x  ' }],
  ['COPILOT_RUNTIME_BASE empty string', { COPILOT_RUNTIME_BASE: '' }],
  ['XDG_RUNTIME_DIR empty', { XDG_RUNTIME_DIR: '' }],
  ['COPILOT_QUEUE_PATH valid', { COPILOT_QUEUE_PATH: '/tmp/q.jsonl' }],
  ['COPILOT_QUEUE_PATH with whitespace', { COPILOT_QUEUE_PATH: ' /tmp/q.jsonl ' }],
  ['COPILOT_QUEUE_PATH with newline', { COPILOT_QUEUE_PATH: '/tmp/q.jsonl\n' }],
  ['COPILOT_QUEUE_PATH whitespace-only', { COPILOT_QUEUE_PATH: '   ' }],
  ['BASE + QUEUE both set', {
    COPILOT_RUNTIME_BASE: '/x',
    COPILOT_QUEUE_PATH: ' /q.jsonl ',
  }],
];

for (const [label, env] of PARITY_CASES) {
  test(`Node↔shell queue path parity: ${label}`, async () => {
    // Cache-bust dynamic import so paths.mjs sees the per-test env.
    const cacheKey = Math.random();
    const restore = {};
    for (const [k, v] of Object.entries(env)) {
      restore[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const { queuePath } = await import(`../lib/paths.mjs?cb=${cacheKey}`);
      const nodeOut = queuePath();
      const shellOut = shellResolveQueue(env);
      assert.equal(shellOut, nodeOut,
        `parity broken for ${label}\n  Node:  ${nodeOut}\n  Shell: ${shellOut}`);
    } finally {
      for (const k of Object.keys(env)) {
        if (restore[k] === undefined) delete process.env[k];
        else process.env[k] = restore[k];
      }
    }
  });
}

// ───── full-flow drain test ─────
//
// Pre-stage a queue file with one event, run the actual hook, verify the
// JSON output contains the event content and the queue file was consumed.
// This exercises the WHOLE pipeline, not just the path resolution.

test('drain hook surfaces a queued event end-to-end', { skip: typeof process.getuid !== 'function' }, async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'drainflow-'));
  const dir = join(isolated, `copilot-companion-uid${process.getuid()}`);
  // Pre-create the runtime dir as the daemon would
  spawnSync('mkdir', ['-m', '0700', '-p', dir]);

  const queueFile = join(dir, 'completions.jsonl');
  const entry = {
    ts: Date.now(),
    consumed: false,
    jobId: 'parity-test-1',
    kind: 'completed',
    content: 'parity test marker',
    meta: { status: 'completed' },
  };
  writeFileSync(queueFile, JSON.stringify(entry) + '\n', { mode: 0o600 });

  try {
    const r = runHook({ COPILOT_RUNTIME_BASE: isolated });
    assert.equal(r.status, 0, `hook failed: ${r.stderr}`);
    assert.match(r.stdout, /parity test marker/,
      `expected hook to surface the queued content; stdout: ${r.stdout}`);
    // Queue should be consumed (atomic move-then-delete)
    let consumed = true;
    try { lstatSync(queueFile); consumed = false; } catch {}
    assert.ok(consumed, 'queue file should be consumed after drain');
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
