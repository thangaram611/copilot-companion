// v6.1 smoke test: server.mjs must be importable from a test process without
// attaching to stdio (which would deadlock the test runner) and must expose
// the dispatcher + jobs map for unit-level testing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('server.mjs is importable without spawning MCP transport', async () => {
  const mod = await import('./server.mjs');
  assert.equal(typeof mod.dispatch, 'function', 'dispatch is exported');
  assert.ok(mod.jobs && typeof mod.jobs.get === 'function', 'jobs Map is exported');
  assert.ok(mod.mcp, 'mcp server instance is exported');
});

test('dispatch rejects unknown actions', async () => {
  const { dispatch } = await import('./server.mjs');
  await assert.rejects(
    () => dispatch({ action: 'frobnicate' }),
    /unhandled action/,
  );
});

test('dispatch reply rejects unknown job_id', async () => {
  const { dispatch } = await import('./server.mjs');
  const result = await dispatch({ action: 'reply', job_id: 'nonexistent-job', message: 'hi' });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.match(body.error, /unknown job_id/);
});

test('dispatch reply rejects job without promptId yet', async () => {
  const { dispatch, jobs } = await import('./server.mjs');
  jobs.set('job-no-prompt', { jobId: 'job-no-prompt', status: 'starting', startedAt: Date.now() });
  try {
    const result = await dispatch({ action: 'reply', job_id: 'job-no-prompt', message: 'hi' });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, false);
    assert.match(body.error, /no prompt yet/);
  } finally {
    jobs.delete('job-no-prompt');
  }
});

test('dispatch reply rejects already-terminal job', async () => {
  const { dispatch, jobs } = await import('./server.mjs');
  jobs.set('job-done', {
    jobId: 'job-done', status: 'completed', promptId: 'p1',
    startedAt: Date.now() - 1000, terminalAt: Date.now(),
  });
  try {
    const result = await dispatch({ action: 'reply', job_id: 'job-done', message: 'hi' });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, false);
    assert.match(body.error, /already completed/);
  } finally {
    jobs.delete('job-done');
  }
});

test('dispatch cancel rejects unknown job_id', async () => {
  const { dispatch } = await import('./server.mjs');
  const result = await dispatch({ action: 'cancel', job_id: 'nonexistent' });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.match(body.error, /unknown job_id/);
});

test('dispatch wait on unknown job returns status=unknown_job', async () => {
  const { dispatch } = await import('./server.mjs');
  const result = await dispatch({ action: 'wait', job_id: 'missing', max_wait_sec: 1 });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.status, 'unknown_job');
});

test('dispatch status without job_id returns global snapshot', async () => {
  const { dispatch } = await import('./server.mjs');
  const result = await dispatch({ action: 'status', job_id: null, verbose: false });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.action, 'status');
  assert.ok(Array.isArray(body.running_jobs), 'running_jobs is an array');
  assert.ok(body.default_model, 'default_model present');
  // v6.1: must NOT carry session-oriented fields.
  assert.equal(body.active, undefined);
  assert.equal(body.paused, undefined);
  assert.equal(body.active_sessions_total, undefined);
});

test('classifyRubberDuck: clean verdict', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  assert.equal(classifyRubberDuck('Did the thing.\n\nRUBBER-DUCK: clean.'), 'clean');
  assert.equal(classifyRubberDuck('RUBBER-DUCK: clean.'), 'clean');
  assert.equal(classifyRubberDuck('body\n rubber-duck: CLEAN'), 'clean');
});

test('classifyRubberDuck: revised verdict', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  assert.equal(classifyRubberDuck('Did it.\n\nRUBBER-DUCK: revised — dropped the foo claim.'), 'revised');
  assert.equal(classifyRubberDuck('RUBBER-DUCK: revised'), 'revised');
});

test('classifyRubberDuck: missing when no marker', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  assert.equal(classifyRubberDuck('just an answer with no verdict'), 'missing');
  assert.equal(classifyRubberDuck(''), 'missing');
  assert.equal(classifyRubberDuck(null), 'missing');
  assert.equal(classifyRubberDuck(undefined), 'missing');
});

test('classifyRubberDuck: ignores unrelated words after prefix', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  // "clear" and "revival" start with c/r but should not match clean|revised
  assert.equal(classifyRubberDuck('RUBBER-DUCK: clear signal'), 'missing');
  assert.equal(classifyRubberDuck('RUBBER-DUCK: revival'), 'missing');
});

// ---------- clampWaitSec: mode-aware caps ----------

test('clampWaitSec: ANALYZE permits up to 900s', async () => {
  const { clampWaitSec } = await import('./server.mjs');
  assert.equal(clampWaitSec(700, 'ANALYZE'), 700);
  assert.equal(clampWaitSec(900, 'ANALYZE'), 900);
  assert.equal(clampWaitSec(1200, 'ANALYZE'), 900);
});

test('clampWaitSec: non-ANALYZE caps at 540', async () => {
  const { clampWaitSec } = await import('./server.mjs');
  assert.equal(clampWaitSec(700, 'EXECUTE'), 540);
  assert.equal(clampWaitSec(700, 'PLAN'), 540);
  assert.equal(clampWaitSec(540, 'EXECUTE'), 540);
  assert.equal(clampWaitSec(300, 'EXECUTE'), 300);
});

test('clampWaitSec: defaults missing/zero/non-numeric to 480', async () => {
  const { clampWaitSec } = await import('./server.mjs');
  assert.equal(clampWaitSec(undefined, 'EXECUTE'), 480);
  assert.equal(clampWaitSec(null, 'EXECUTE'), 480);
  assert.equal(clampWaitSec(0, 'EXECUTE'), 480);
  assert.equal(clampWaitSec('not a number', 'EXECUTE'), 480);
  assert.equal(clampWaitSec(undefined, 'ANALYZE'), 480);
});

test('clampWaitSec: floor of 1 (no zero-wait races)', async () => {
  const { clampWaitSec } = await import('./server.mjs');
  assert.equal(clampWaitSec(1, 'EXECUTE'), 1);
  // Note: 0 hits the `|| 480` default branch above; only positive values
  // smaller than 1 (which Number can produce from string '0.5') flow through
  // the floor.
  assert.equal(clampWaitSec(0.4, 'EXECUTE'), 1);
});

// ---------- formatTerminalContent: timeout + unreachable branches ----------

test('formatTerminalContent: timeout body lists decompose / scope_hint / parallel:false', async () => {
  // formatTerminalContent isn't exported directly, so we exercise it via the
  // emitNotification → enqueueEvent path is too heavy. Instead, drive it
  // through a test-only re-import of the module's internal: easiest is to
  // shape a stuck-style synthetic job and call formatTerminalContent through
  // its public path. Since the function isn't exported, we test the *content*
  // contract via an integration assertion: handle a synthetic timeout job
  // through buildWaitResponse.
  const mod = await import('./server.mjs');
  const { jobs } = mod;
  const jobId = 'job-test-timeout';
  jobs.set(jobId, {
    jobId,
    status: 'timeout',
    task: 'analyze a giant file',
    mode: 'ANALYZE',
    durationMs: 540_000,
    failedTools: ['view', 'grep'],
    promptId: 'p-timeout',
    sessionId: 's-timeout',
    thread: 'companion-test',
    startedAt: Date.now() - 540_000,
    terminalAt: Date.now(),
    retentionExpiresAt: Date.now() + 60_000,
  });
  try {
    const res = await mod.dispatch({ action: 'wait', job_id: jobId, max_wait_sec: 1 });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.status, 'timeout');
    assert.match(body.content, /Copilot's model turn did not finish/);
    assert.match(body.content, /Decompose the task/);
    assert.match(body.content, /scope_hint/);
    assert.match(body.content, /parallel: false/);
    assert.match(body.content, /\*\*Failed tools:\*\* view, grep/);
  } finally {
    jobs.delete(jobId);
  }
});

test('formatTerminalContent: unreachable body cites daemon / log paths', async () => {
  const mod = await import('./server.mjs');
  const { jobs } = mod;
  const jobId = 'job-test-unreachable';
  jobs.set(jobId, {
    jobId,
    status: 'unreachable',
    task: 'something',
    mode: 'EXECUTE',
    detail: 'bridge_daemon_unreachable',
    durationMs: 1000,
    failedTools: [],
    startedAt: Date.now() - 1000,
    terminalAt: Date.now(),
    retentionExpiresAt: Date.now() + 60_000,
  });
  try {
    const res = await mod.dispatch({ action: 'wait', job_id: jobId, max_wait_sec: 1 });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.status, 'unreachable');
    assert.match(body.content, /Bridge could not reach the Copilot daemon/);
    assert.match(body.content, /detail: bridge_daemon_unreachable/);
    assert.match(body.content, /copilot-acp-daemon/);
    assert.equal(body.meta.detail, 'bridge_daemon_unreachable');
  } finally {
    jobs.delete(jobId);
  }
});

// ---------- buildJobResponse: status precedence + detail ----------

test('buildJobResponse: bridge timeout wins over inspect data.status', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  const job = {
    jobId: 'j1', status: 'timeout', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
    detail: null,
  };
  // Daemon inspect comes back saying "failed" (which would be the underlying
  // raw status it knows about) — bridge remap to "timeout" must win.
  const out = buildJobResponse(job, { status: 'failed', stuckReason: null });
  assert.equal(out.status, 'timeout');
});

test('buildJobResponse: bridge unreachable wins over inspect data.status', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  const job = {
    jobId: 'j2', status: 'unreachable', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
    detail: 'bridge_daemon_unreachable',
  };
  const out = buildJobResponse(job, { status: 'completed', summary: { message: 'oops' } });
  assert.equal(out.status, 'unreachable');
});

test('buildJobResponse: inspect status wins for non-bridge-remap statuses', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  // Mid-flight job: inspect is the source of truth for live status.
  const job = { jobId: 'j3', status: 'starting', startedAt: Date.now() };
  const out = buildJobResponse(job, { status: 'running' });
  assert.equal(out.status, 'running');
});

test('buildJobResponse: surfaces detail field when set on job', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  const job = {
    jobId: 'j4', status: 'unreachable', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
    detail: 'bridge_timeout',
  };
  const out = buildJobResponse(job);
  assert.equal(out.detail, 'bridge_timeout');
});

test('buildJobResponse: detail null when not set', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  const job = {
    jobId: 'j5', status: 'completed', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
  };
  const out = buildJobResponse(job);
  assert.equal(out.detail, null);
});

test('buildJobResponse: ignores spurious data.detail (bridge-owned)', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  // If a future daemon change starts emitting a `detail` field, the bridge's
  // authoritative value (or null) must still win — daemon should not be able
  // to override the bridge's status-detail invariant.
  const job = {
    jobId: 'j6', status: 'completed', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
    detail: null,
  };
  const out = buildJobResponse(job, { status: 'completed', detail: 'spurious_from_daemon' });
  assert.equal(out.detail, null);
});

// ---------- emitNotification: queue write carries meta.detail ----------

test('emitNotification: writes meta.detail to queue file when detail set', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // Redirect queue path BEFORE invoking emitNotification (getQueuePath is
  // resolved per-call, so this works even after server.mjs has been imported).
  const tmp = mkdtempSync(join(tmpdir(), 'copilot-queue-test-'));
  const queueFile = join(tmp, 'completions.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  try {
    const { emitNotification } = await import('./server.mjs');
    emitNotification({
      jobId: 'j-notif',
      status: 'unreachable',
      summary: null,
      error: null,
      stuckReason: null,
      detail: 'bridge_daemon_unreachable',
      duration: 1234,
      task: 'X',
      mode: 'EXECUTE',
      cwd: '/tmp',
    });
    const content = readFileSync(queueFile, 'utf8');
    const event = JSON.parse(content.trim().split('\n').pop());
    assert.equal(event.kind, 'terminal');
    assert.equal(event.meta.status, 'unreachable');
    assert.equal(event.meta.detail, 'bridge_daemon_unreachable');
  } finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH; else process.env.COPILOT_QUEUE_PATH = oldQ;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('emitNotification: omits meta.detail when no detail provided', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'copilot-queue-test-'));
  const queueFile = join(tmp, 'completions.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  try {
    const { emitNotification } = await import('./server.mjs');
    emitNotification({
      jobId: 'j-notif-no-detail',
      status: 'completed',
      summary: { message: 'done.\n\nRUBBER-DUCK: clean.' },
      duration: 100,
      task: 'X',
      mode: 'EXECUTE',
      cwd: '/tmp',
    });
    const content = readFileSync(queueFile, 'utf8');
    const event = JSON.parse(content.trim().split('\n').pop());
    assert.equal(event.meta.status, 'completed');
    assert.equal(event.meta.detail, undefined);
  } finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH; else process.env.COPILOT_QUEUE_PATH = oldQ;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- classifyRubberDuck: multi-verdict (fleet sub-agents) ----------

test('classifyRubberDuck: multiple clean verdicts → clean', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  const msg = 'sub-agent A:\n\nRUBBER-DUCK: clean.\n\nsub-agent B:\n\nRUBBER-DUCK: clean.';
  assert.equal(classifyRubberDuck(msg), 'clean');
});

test('classifyRubberDuck: one revised among many cleans → revised (fail-pessimistic)', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  const msg = 'sub-agent A:\n\nRUBBER-DUCK: clean.\n\nsub-agent B:\n\nRUBBER-DUCK: revised — fixed a hallucination.\n\nsub-agent C:\n\nRUBBER-DUCK: clean.';
  // Earlier behavior (using .match instead of .matchAll) would silently
  // downgrade this to "clean" because the first match wins.
  assert.equal(classifyRubberDuck(msg), 'revised');
});

test('classifyRubberDuck: revised then clean → revised', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  const msg = 'RUBBER-DUCK: revised — note.\n\nlater: RUBBER-DUCK: clean.';
  assert.equal(classifyRubberDuck(msg), 'revised');
});

test('buildWaitResponse: meta.detail omitted when no detail set', async () => {
  const mod = await import('./server.mjs');
  const { jobs } = mod;
  const jobId = 'job-test-completed';
  jobs.set(jobId, {
    jobId,
    status: 'completed',
    task: 'X',
    mode: 'EXECUTE',
    durationMs: 1000,
    failedTools: [],
    summary: { message: 'done.\n\nRUBBER-DUCK: clean.' },
    startedAt: Date.now() - 1000,
    terminalAt: Date.now(),
    retentionExpiresAt: Date.now() + 60_000,
  });
  try {
    const res = await mod.dispatch({ action: 'wait', job_id: jobId, max_wait_sec: 1 });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.status, 'completed');
    assert.equal(body.meta.detail, undefined);
  } finally {
    jobs.delete(jobId);
  }
});
