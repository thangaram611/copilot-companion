// State-layer round-trip tests. Runs in an isolated directory via
// COPILOT_COMPANION_HOME so the user's real state is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set the home override BEFORE importing the state module so constants bind to it.
const SANDBOX = mkdtempSync(join(tmpdir(), 'copilot-state-'));
process.env.COPILOT_COMPANION_HOME = SANDBOX;

const state = await import('./state.mjs');

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

// ---------- default-model ----------

test('default-model falls back when file missing', () => {
  state.clearDefaultModel();
  const r = state.readDefaultModel();
  assert.equal(r.model, state.DEFAULT_MODEL);
  assert.equal(r.source, 'fallback');
});

test('default-model round-trip + allow-list check', () => {
  state.writeDefaultModel('gpt-5.4');
  const r = state.readDefaultModel();
  assert.equal(r.model, 'gpt-5.4');
  assert.equal(r.source, 'config');
  assert.equal(state.isModelAllowed('gpt-5.4'), true);
  assert.equal(state.isModelAllowed('fake-model'), false);
  state.clearDefaultModel();
});

test('default-model empty file → fallback', () => {
  assert.throws(() => state.writeDefaultModel(' '), /empty id/);
});

test('writeDefaultModel rejects empty', () => {
  assert.throws(() => state.writeDefaultModel(''), /empty id/);
});

// ---------- threads/ ----------

test('thread sid round-trip', () => {
  assert.equal(state.readThreadSid('t1'), null);
  state.writeThreadSid('t1', 'sid-abc-1');
  assert.equal(state.readThreadSid('t1'), 'sid-abc-1');
  state.writeThreadSid('t1', 'sid-abc-2');
  assert.equal(state.readThreadSid('t1'), 'sid-abc-2');
  state.clearThread('t1');
  assert.equal(state.readThreadSid('t1'), null);
});

test('invalid thread name rejected', () => {
  assert.throws(() => state.readThreadSid('../x'), /invalid thread name/);
  assert.throws(() => state.writeThreadSid('a/b', 's'), /invalid thread name/);
});

test('clearAllThreads wipes everything', () => {
  state.writeThreadSid('th-a', 'sid-a');
  state.writeThreadSid('th-b', 'sid-b');
  assert.ok(state.listThreads().length >= 2);
  state.clearAllThreads();
  assert.equal(state.listThreads().length, 0);
});

// v6.1 A7: atomicWrite must use a tmp file in the SAME directory as the
// target so the rename stays intra-filesystem and atomic.
test('atomicWrite uses dirname for tmp file (no leftover in tmpdir)', async () => {
  const { readdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  state.writeDefaultModel('claude-opus-4.6');
  const dir = dirname(state.MODEL_FILE);
  const leftover = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
  state.clearDefaultModel();
});

// ---------- jobs/ ----------

test('writeJob/readJob round-trip', () => {
  const data = {
    jobId: 'copilot-abc123',
    promptId: 'p-1',
    copilotSessionId: 'cop-sid-1',
    claudeSessionId: 'cc-sid-A',
    status: 'running',
    startedAt: 1000,
  };
  state.writeJob('copilot-abc123', data);
  const back = state.readJob('copilot-abc123');
  assert.deepEqual(back, data);
});

test('readJob returns null for missing job', () => {
  assert.equal(state.readJob('nonexistent-job'), null);
});

test('listJobsForSession filters by claudeSessionId', () => {
  state.writeJob('j-A1', { jobId: 'j-A1', claudeSessionId: 'sid-A', status: 'running' });
  state.writeJob('j-A2', { jobId: 'j-A2', claudeSessionId: 'sid-A', status: 'completed' });
  state.writeJob('j-B1', { jobId: 'j-B1', claudeSessionId: 'sid-B', status: 'running' });

  const aJobs = state.listJobsForSession('sid-A');
  const bJobs = state.listJobsForSession('sid-B');
  const cJobs = state.listJobsForSession('sid-C');
  assert.equal(aJobs.length, 2);
  assert.equal(bJobs.length, 1);
  assert.equal(cJobs.length, 0);
  assert.deepEqual(aJobs.map((j) => j.jobId).sort(), ['j-A1', 'j-A2']);

  state.deleteJob('j-A1');
  state.deleteJob('j-A2');
  state.deleteJob('j-B1');
});

test('listJobsForSession returns [] for null/empty sid', () => {
  assert.deepEqual(state.listJobsForSession(null), []);
  assert.deepEqual(state.listJobsForSession(''), []);
});

test('deleteJob is idempotent on missing file', () => {
  state.deleteJob('never-existed');
  state.deleteJob('never-existed');
  assert.equal(state.readJob('never-existed'), null);
});

test('writeJob rejects invalid jobId', () => {
  assert.throws(() => state.writeJob('../escape', { jobId: 'x' }), /invalid job id/);
  assert.throws(() => state.writeJob('a/b', { jobId: 'x' }), /invalid job id/);
});

test('writeJob rejects non-object data', () => {
  assert.throws(() => state.writeJob('valid-id', null), /must be an object/);
  assert.throws(() => state.writeJob('valid-id', 'string'), /must be an object/);
});

// ---------- threads/by-host-session/ ----------

test('host-session→thread round-trip', () => {
  const sid = '019e0dc8-94b3-7172-abeb-60578f8a8a8d';
  assert.equal(state.readHostSessionThread(sid), null);
  state.writeHostSessionThread(sid, 'companion-copilot-abc');
  assert.equal(state.readHostSessionThread(sid), 'companion-copilot-abc');
  state.writeHostSessionThread(sid, 'companion-copilot-xyz');
  assert.equal(state.readHostSessionThread(sid), 'companion-copilot-xyz');
  state.clearHostSessionThread(sid);
  assert.equal(state.readHostSessionThread(sid), null);
});

test('host-session id allowlist is enforced', () => {
  assert.throws(() => state.readHostSessionThread('../escape'), /invalid host session id/);
  assert.throws(() => state.writeHostSessionThread('a/b', 't'), /invalid host session id/);
  assert.throws(() => state.writeHostSessionThread('', 't'), /invalid host session id/);
});

test('writeHostSessionThread rejects empty thread name', () => {
  assert.throws(() => state.writeHostSessionThread('sid-1', ''), /empty thread name/);
  assert.throws(() => state.writeHostSessionThread('sid-1', '   '), /empty thread name/);
});

test('writeHostSessionThread rejects malformed thread name', () => {
  assert.throws(() => state.writeHostSessionThread('sid-1', 'thread/with/slash'), /invalid thread name/);
});
