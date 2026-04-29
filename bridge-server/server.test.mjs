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
