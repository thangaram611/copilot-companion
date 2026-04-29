// Tests for lib/log.mjs (v6.1 E1/E2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX = mkdtempSync(join(tmpdir(), 'copilot-log-'));
process.env.COPILOT_COMPANION_HOME = SANDBOX;
process.env.COPILOT_LOG_LEVEL = 'trace';

const log = await import('./log.mjs');

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

test('createReqId emits a stable-shape id', () => {
  const id = log.createReqId();
  assert.match(id, /^req_[0-9a-z]+_[0-9a-f]{12}$/);
  // Two ids should be unique.
  assert.notEqual(id, log.createReqId());
});

test('logEvent appends a JSON line with required fields', () => {
  log.logEvent('info', 'unit.test', { req_id: 'req_x', job_id: 'job_y' });
  const lines = readFileSync(log.LOG_FILE, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.event, 'unit.test');
  assert.equal(last.level, 'info');
  assert.equal(last.req_id, 'req_x');
  assert.equal(last.job_id, 'job_y');
  assert.ok(last.ts);
  assert.equal(typeof last.pid, 'number');
});

test('withReq prefixes every call with req_id', () => {
  const r = log.withReq('req_abc', { job_id: 'job_q' });
  r.info('something.happened', { detail: 1 });
  const lines = readFileSync(log.LOG_FILE, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.req_id, 'req_abc');
  assert.equal(last.job_id, 'job_q');
  assert.equal(last.detail, 1);
});

test('log file is created with 0600 perms', () => {
  log.logEvent('info', 'perm.check');
  const st = statSync(log.LOG_FILE);
  // mask off file-type bits
  assert.equal(st.mode & 0o777, 0o600);
});
