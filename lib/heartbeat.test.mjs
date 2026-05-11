// heartbeat.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectLiveHeartbeat } from './heartbeat.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TTL = 30 * MIN;     // matches HOST_LIVENESS_TTL_MS
const STALE = 24 * HOUR;  // matches HEARTBEAT_STALE_AFTER_MS

test('selectLiveHeartbeat: empty entries → no liveSid, no sweep', () => {
  const r = selectLiveHeartbeat({ entries: [], nowMs: 1000, liveTtlMs: TTL, staleAfterMs: STALE });
  assert.equal(r.liveSid, null);
  assert.deepEqual(r.staleToUnlink, []);
});

test('selectLiveHeartbeat: freshest among multiple live sids wins', () => {
  const now = 10 * HOUR;
  const r = selectLiveHeartbeat({
    entries: [
      { name: 'sid-old.heartbeat',   mtimeMs: now - 20 * MIN }, // within TTL but older
      { name: 'sid-fresh.heartbeat', mtimeMs: now - 1 * MIN  }, // freshest
      { name: 'sid-mid.heartbeat',   mtimeMs: now - 10 * MIN }, // mid
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(r.liveSid, 'sid-fresh');
  assert.deepEqual(r.staleToUnlink, []);
});

test('selectLiveHeartbeat: exactly at TTL boundary counts as live', () => {
  const now = 10 * HOUR;
  const r = selectLiveHeartbeat({
    entries: [{ name: 'sid-boundary.heartbeat', mtimeMs: now - TTL }],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(r.liveSid, 'sid-boundary');
});

test('selectLiveHeartbeat: 1ms past TTL is not live', () => {
  const now = 10 * HOUR;
  const r = selectLiveHeartbeat({
    entries: [{ name: 'sid-expired.heartbeat', mtimeMs: now - TTL - 1 }],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(r.liveSid, null);
  // Not stale either — between TTL and staleAfter.
  assert.deepEqual(r.staleToUnlink, []);
});

test('selectLiveHeartbeat: only-expired-not-yet-stale → null + no sweep', () => {
  const now = 48 * HOUR;
  const r = selectLiveHeartbeat({
    entries: [
      { name: 'sid-a.heartbeat', mtimeMs: now - (TTL + MIN) },  // expired, not stale
      { name: 'sid-b.heartbeat', mtimeMs: now - 2 * HOUR },     // expired, not stale
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(r.liveSid, null);
  assert.deepEqual(r.staleToUnlink, []);
});

test('selectLiveHeartbeat: entries older than staleAfterMs queued for unlink', () => {
  const now = 48 * HOUR;
  const r = selectLiveHeartbeat({
    entries: [
      { name: 'sid-old.heartbeat',  mtimeMs: now - STALE - HOUR }, // way stale
      { name: 'sid-fresh.heartbeat', mtimeMs: now - 5 * MIN },     // live
      { name: 'sid-mid.heartbeat',   mtimeMs: now - HOUR },        // expired, not stale
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(r.liveSid, 'sid-fresh');
  assert.deepEqual(r.staleToUnlink, ['sid-old.heartbeat']);
});

test('selectLiveHeartbeat: ignores non-.heartbeat files', () => {
  const now = 10 * HOUR;
  const r = selectLiveHeartbeat({
    entries: [
      { name: 'sid-real.heartbeat', mtimeMs: now - 1 * MIN },
      { name: 'README.md',          mtimeMs: now - 1 * MIN },
      { name: 'sid-bare',           mtimeMs: now - 1 * MIN },
      { name: '.DS_Store',          mtimeMs: now - 1 * MIN },
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(r.liveSid, 'sid-real');
});

test('selectLiveHeartbeat: rejects entries with bogus mtimeMs', () => {
  const now = 10 * HOUR;
  const r = selectLiveHeartbeat({
    entries: [
      { name: 'sid-good.heartbeat', mtimeMs: now - 1 * MIN },
      { name: 'sid-nan.heartbeat',  mtimeMs: NaN },
      { name: 'sid-undef.heartbeat' },
      { name: 'sid-str.heartbeat',  mtimeMs: 'not a number' },
      null,
      undefined,
      { /* no name */ mtimeMs: now },
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(r.liveSid, 'sid-good');
  assert.deepEqual(r.staleToUnlink, []);
});

test('selectLiveHeartbeat: tied mtimes pick one deterministically (the later-iterated wins)', () => {
  // Documents the current tie-break: iteration order on equal mtimes. Not a
  // correctness-critical detail, but pinning it avoids flaky tests if someone
  // ever changes the comparator.
  const now = 10 * HOUR;
  const tieMtime = now - 5 * MIN;
  const r = selectLiveHeartbeat({
    entries: [
      { name: 'sid-a.heartbeat', mtimeMs: tieMtime },
      { name: 'sid-b.heartbeat', mtimeMs: tieMtime },
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  // Strict `>` comparator means the first-encountered wins.
  assert.equal(r.liveSid, 'sid-a');
});
