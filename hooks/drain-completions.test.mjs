// drain-completions.sh — integration tests via shell-out.
//
// Tests build a queue file with crafted rows, invoke the drain script with a
// stdin payload mimicking Claude Code's hook envelope, then inspect the
// hook's stdout (injection) and the post-drain queue file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SCRIPT = join(__dirname, 'drain-completions.sh');

function makeQueueFile(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-test-'));
  const path = join(dir, 'completions.jsonl');
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, path };
}

function runDrain({ queuePath, payload }) {
  const stdout = execFileSync('bash', [SCRIPT], {
    input: JSON.stringify(payload),
    env: { ...process.env, COPILOT_QUEUE_PATH: queuePath },
    encoding: 'utf8',
  });
  return stdout.trim();
}

function readQueueRows(queuePath) {
  if (!existsSync(queuePath)) return [];
  const raw = readFileSync(queuePath, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const NOW = Date.now();
const FRESH_TS = NOW - 30_000;       // 30 sec ago — well within both TTLs
const FRESH_ALERT_TS = NOW - 60_000; // 1 min ago — within 5 min alert TTL
const STALE_ALERT_TS = NOW - 6 * 60_000;   // 6 min ago — past 5 min alert TTL
const STALE_TERMINAL_TS = NOW - 31 * 60_000; // 31 min ago — past 30 min terminal TTL

// ---------- (k) sid filter — own-session-only injection ----------

test('drain: delivers only rows matching this session, retains other sessions', () => {
  const { dir, path } = makeQueueFile([
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-A', claudeSessionId: 'sid-A',
      consumed: false, content: 'A done', meta: { status: 'completed' } },
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-B', claudeSessionId: 'sid-B',
      consumed: false, content: 'B done', meta: { status: 'completed' } },
  ]);
  try {
    const out = runDrain({ queuePath: path, payload: { hook_event_name: 'PostToolUse', session_id: 'sid-A' } });
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /j-A/);
    assert.doesNotMatch(ctx, /j-B/);

    const remaining = readQueueRows(path);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].jobId, 'j-B');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- (l) alert TTL — 5 min ----------

test('drain: alert older than 5 min is dropped, fresh alert delivered', () => {
  const { dir, path } = makeQueueFile([
    { ts: STALE_ALERT_TS, kind: 'alert', jobId: 'j-stale', claudeSessionId: 'sid-A',
      consumed: false, content: 'stale watchdog' },
    { ts: FRESH_ALERT_TS, kind: 'alert', jobId: 'j-fresh', claudeSessionId: 'sid-A',
      consumed: false, content: 'fresh watchdog' },
  ]);
  try {
    const out = runDrain({ queuePath: path, payload: { hook_event_name: 'PostToolUse', session_id: 'sid-A' } });
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /j-fresh/);
    assert.doesNotMatch(ctx, /j-stale/);

    const remaining = readQueueRows(path);
    assert.equal(remaining.length, 0, 'stale alert dropped, fresh delivered → queue empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- (m) terminal TTL — 30 min ----------

test('drain: terminal older than 30 min is dropped, fresh terminal delivered', () => {
  const { dir, path } = makeQueueFile([
    { ts: STALE_TERMINAL_TS, kind: 'terminal', jobId: 'j-old', claudeSessionId: 'sid-A',
      consumed: false, content: 'old', meta: { status: 'completed' } },
    { ts: NOW - 29 * 60_000, kind: 'terminal', jobId: 'j-recent', claudeSessionId: 'sid-A',
      consumed: false, content: 'recent', meta: { status: 'completed' } },
  ]);
  try {
    const out = runDrain({ queuePath: path, payload: { hook_event_name: 'PostToolUse', session_id: 'sid-A' } });
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /j-recent/);
    assert.doesNotMatch(ctx, /j-old/);

    const remaining = readQueueRows(path);
    assert.equal(remaining.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- (n) empty session id — refuse to inject ----------

test('drain: empty session_id in payload → exit 0, no injection, queue unchanged', () => {
  const rows = [
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-A', claudeSessionId: 'sid-A',
      consumed: false, content: 'A', meta: { status: 'completed' } },
  ];
  const { dir, path } = makeQueueFile(rows);
  try {
    const out = runDrain({ queuePath: path, payload: { hook_event_name: 'PostToolUse' } }); // no session_id
    assert.equal(out, '');

    const remaining = readQueueRows(path);
    assert.deepEqual(remaining, rows, 'queue unchanged when drain refuses to act');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- untagged rows always dropped ----------

test('drain: untagged rows (claudeSessionId=null) dropped, never delivered', () => {
  const { dir, path } = makeQueueFile([
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-untagged', claudeSessionId: null,
      consumed: false, content: 'orphan', meta: { status: 'completed' } },
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-tagged', claudeSessionId: 'sid-A',
      consumed: false, content: 'tagged', meta: { status: 'completed' } },
  ]);
  try {
    const out = runDrain({ queuePath: path, payload: { hook_event_name: 'PostToolUse', session_id: 'sid-A' } });
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /j-tagged/);
    assert.doesNotMatch(ctx, /j-untagged/);

    const remaining = readQueueRows(path);
    assert.equal(remaining.length, 0, 'untagged dropped, tagged delivered → queue empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- consumed rows dropped ----------

test('drain: own-session consumed rows dropped without redelivery', () => {
  const { dir, path } = makeQueueFile([
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-consumed', claudeSessionId: 'sid-A',
      consumed: true, content: 'already delivered', meta: { status: 'completed' } },
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-pending', claudeSessionId: 'sid-A',
      consumed: false, content: 'fresh', meta: { status: 'completed' } },
  ]);
  try {
    const out = runDrain({ queuePath: path, payload: { hook_event_name: 'PostToolUse', session_id: 'sid-A' } });
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /j-pending/);
    assert.doesNotMatch(ctx, /j-consumed/);

    const remaining = readQueueRows(path);
    assert.equal(remaining.length, 0, 'consumed dropped, pending delivered → queue empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- (o) mkdir-lock concurrency ----------

test('drain: concurrent drains for different sids — no row double-delivered or lost', async () => {
  const { dir, path } = makeQueueFile([
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-A1', claudeSessionId: 'sid-A',
      consumed: false, content: 'A1', meta: { status: 'completed' } },
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-A2', claudeSessionId: 'sid-A',
      consumed: false, content: 'A2', meta: { status: 'completed' } },
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-B1', claudeSessionId: 'sid-B',
      consumed: false, content: 'B1', meta: { status: 'completed' } },
  ]);
  try {
    const { spawn } = await import('node:child_process');
    const runOne = (sid) => new Promise((res) => {
      const child = spawn('bash', [SCRIPT], {
        env: { ...process.env, COPILOT_QUEUE_PATH: path },
      });
      let stdout = '';
      child.stdout.on('data', (b) => (stdout += b.toString()));
      child.on('close', () => res(stdout));
      child.stdin.write(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: sid }));
      child.stdin.end();
    });

    const [outA, outB] = await Promise.all([runOne('sid-A'), runOne('sid-B')]);

    // Each session sees exactly its own rows.
    if (outA.trim()) {
      const ctxA = JSON.parse(outA).hookSpecificOutput.additionalContext;
      assert.match(ctxA, /j-A1/);
      assert.match(ctxA, /j-A2/);
      assert.doesNotMatch(ctxA, /j-B1/);
    }
    if (outB.trim()) {
      const ctxB = JSON.parse(outB).hookSpecificOutput.additionalContext;
      assert.match(ctxB, /j-B1/);
      assert.doesNotMatch(ctxB, /j-A/);
    }

    // Outcome possibilities under the lock:
    // - Both ran sequentially, each delivering its own rows. Queue ends empty.
    // - One acquired the lock and ran; the other failed to acquire (skipped).
    //   The skipper's rows are still in the queue. The runner's rows are gone.
    const remaining = readQueueRows(path);
    const remainingIds = remaining.map((r) => r.jobId).sort();
    const acceptable = [
      [],
      ['j-A1', 'j-A2'],
      ['j-B1'],
    ];
    const ok = acceptable.some(
      (a) => a.length === remainingIds.length && a.every((id, i) => id === remainingIds[i]),
    );
    assert.ok(ok, `unexpected post-drain queue state: ${JSON.stringify(remainingIds)}`);

    // Nothing was double-delivered: the union of delivered ids has no duplicates.
    const allDelivered = (outA + outB).match(/j-[AB]\d/g) || [];
    assert.equal(new Set(allDelivered).size, allDelivered.length, 'no double-delivery');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- (p) move-aside preserves rows appended mid-drain ----------

test('drain: row appended to queue mid-drain is not overwritten (move-aside regression)', async () => {
  // Reproduces the P1 race the reviewer flagged: under the prior in-place
  // snapshot+overwrite pattern, any append that landed between the jq read
  // and the final mv was silently lost. The move-aside fix renames the
  // queue first, so concurrent appends go to a freshly-recreated file the
  // drain never touches.
  //
  // We use the script's DEBUG_DRAIN_DELAY env var to hold the drain
  // mid-flight (between rename and partition), then `appendFileSync` a
  // fresh row to the recreated $QUEUE — exactly what bridge.enqueueEvent
  // does in production.
  const { dir, path } = makeQueueFile([
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-pre', claudeSessionId: 'sid-A',
      consumed: false, content: 'pre-drain row', meta: { status: 'completed' } },
  ]);
  const lateRow = {
    ts: Date.now(), kind: 'terminal', jobId: 'j-late', claudeSessionId: 'sid-A',
    consumed: false, content: 'appended mid-drain', meta: { status: 'completed' },
  };
  try {
    const { spawn } = await import('node:child_process');
    const { appendFileSync } = await import('node:fs');

    // Start the drain with a 1.5s hold between rename and partition. The
    // hold gives the test deterministic time to inject the late row before
    // the drain processes the snapshot and rm's it.
    const child = spawn('bash', [SCRIPT], {
      env: {
        ...process.env,
        COPILOT_QUEUE_PATH: path,
        DEBUG_DRAIN_DELAY: '1.5',
      },
    });
    let stdout = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    const closed = new Promise((res) => child.on('close', res));
    child.stdin.write(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'sid-A' }));
    child.stdin.end();

    // Poll until the rename has happened — signaled by $QUEUE no longer
    // existing (mv removed it; the side $DRAIN file holds the snapshot).
    // Without polling, a fast bash startup race could let us append BEFORE
    // the mv, sending j-late into the snapshot and defeating the test.
    const renameDeadline = Date.now() + 3_000;
    while (existsSync(path) && Date.now() < renameDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(!existsSync(path), 'drain should have renamed $QUEUE before the test appends');

    // Append a fresh row to the (no-longer-existing) $QUEUE — appendFileSync
    // creates the file, mirroring what bridge.enqueueEvent does.
    appendFileSync(path, JSON.stringify(lateRow) + '\n');

    await closed;

    // The drain should have delivered j-pre (pre-drain row)…
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /j-pre/);
    assert.doesNotMatch(ctx, /j-late/, 'late row was not in the drain snapshot, so should not be delivered');

    // …and crucially, the late-arriving row must still be in the queue.
    const remaining = readQueueRows(path);
    const remainingIds = remaining.map((r) => r.jobId);
    assert.ok(
      remainingIds.includes('j-late'),
      `late-appended row was overwritten by the drain (post-state: ${JSON.stringify(remainingIds)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
