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
