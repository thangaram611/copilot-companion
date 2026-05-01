import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

import {
  socketPath,
  queuePath,
  eventsPath,
  namespaceTag,
  SECURE_FILE_MODE,
} from './paths.mjs';

test('namespaceTag is non-empty and stable across calls', () => {
  const a = namespaceTag();
  const b = namespaceTag();
  assert.equal(a, b);
  assert.ok(a.length > 0);
  // Either uid<num>, user-<name>, or 'shared'
  assert.match(a, /^(uid\d+|user-[A-Za-z0-9._-]+|shared)$/);
});

test('socketPath lives under tmpdir and embeds the namespace', () => {
  const before = process.env.COPILOT_SOCKET_PATH;
  delete process.env.COPILOT_SOCKET_PATH;
  try {
    const p = socketPath();
    assert.ok(p.startsWith(tmpdir()), `expected ${p} to start with ${tmpdir()}`);
    assert.ok(p.endsWith('.sock'));
    assert.ok(p.includes(namespaceTag()), 'socket path must include namespace tag');
  } finally {
    if (before !== undefined) process.env.COPILOT_SOCKET_PATH = before;
  }
});

test('queuePath lives under tmpdir and embeds the namespace', () => {
  const before = process.env.COPILOT_QUEUE_PATH;
  delete process.env.COPILOT_QUEUE_PATH;
  try {
    const p = queuePath();
    assert.ok(p.startsWith(tmpdir()));
    assert.ok(p.endsWith('.jsonl'));
    assert.ok(p.includes(namespaceTag()));
  } finally {
    if (before !== undefined) process.env.COPILOT_QUEUE_PATH = before;
  }
});

const SAMPLE_UUID = '550e8400-e29b-41d4-a716-446655440000';

test('eventsPath embeds promptId and namespace', () => {
  const p = eventsPath(SAMPLE_UUID);
  assert.ok(p.includes(namespaceTag()));
  assert.ok(p.includes(SAMPLE_UUID));
  assert.ok(p.endsWith('.jsonl'));
});

test('eventsPath rejects falsy or non-string promptId', () => {
  assert.throws(() => eventsPath(''), TypeError);
  assert.throws(() => eventsPath(null), TypeError);
  assert.throws(() => eventsPath(undefined), TypeError);
  assert.throws(() => eventsPath(42), TypeError);
});

test('eventsPath rejects path-traversal attempts in promptId', () => {
  // The whole point of the guard: even though the daemon only ever passes
  // randomUUID() output, the function's contract must not let crafted input
  // escape TMPDIR.
  assert.throws(() => eventsPath('../etc/passwd'), TypeError);
  assert.throws(() => eventsPath('..'), TypeError);
  assert.throws(() => eventsPath('foo/bar'), TypeError);
  assert.throws(() => eventsPath('foo\\bar'), TypeError);
  assert.throws(() => eventsPath('abc-123'), TypeError); // not a UUID
  assert.throws(() => eventsPath(SAMPLE_UUID + '\n../escape'), TypeError);
  assert.throws(() => eventsPath(SAMPLE_UUID + '/../escape'), TypeError);
});

test('eventsPath accepts uppercase UUID variants', () => {
  // randomUUID() always lowercases, but the regex is case-insensitive so
  // operators piping in trace UUIDs from logs still work.
  const upper = SAMPLE_UUID.toUpperCase();
  const p = eventsPath(upper);
  assert.ok(p.includes(upper));
});

test('COPILOT_QUEUE_PATH env override wins over default', () => {
  const before = process.env.COPILOT_QUEUE_PATH;
  process.env.COPILOT_QUEUE_PATH = '/var/tmp/test-override.jsonl';
  try {
    assert.equal(queuePath(), '/var/tmp/test-override.jsonl');
  } finally {
    if (before === undefined) delete process.env.COPILOT_QUEUE_PATH;
    else process.env.COPILOT_QUEUE_PATH = before;
  }
});

test('COPILOT_SOCKET_PATH env override wins over default', () => {
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
