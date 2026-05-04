// daemon-client.test.mjs
//
// Integration test for the security property the upstream PR-#1 review
// caught manually: sendToSocket() must verify the per-user runtime dir
// BEFORE it tries to connect, even when the caller never goes through
// ensureDaemon(). Without this property, a future refactor that hoists
// ensureRuntimeDir() back into ensureDaemon() only would silently revert
// the Codex fix in commit afb6dca.
//
// Note on technique: daemon-client.mjs captures SOCKET_PATH = socketPath()
// at module-load time. To test against an isolated runtime base, the
// dynamic import below uses a cache-busting query param so we get a
// fresh module bound to the per-test env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, lstatSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

test('sendToSocket establishes runtime dir at 0o700 before connect', { skip: typeof process.getuid !== 'function' }, async () => {
  const baseBefore = process.env.COPILOT_RUNTIME_BASE;
  const isolated = mkdtempSync(join(tmpdir(), 'sendto-test-'));
  process.env.COPILOT_RUNTIME_BASE = isolated;

  try {
    // Cache-bust the module load so SOCKET_PATH captures the new env.
    const mod = await import(`./daemon-client.mjs?cb=${Math.random()}`);

    // No daemon is listening at the per-test path, so the connect will
    // fail. We don't care about that — we care that the runtime dir was
    // verified BEFORE the connect attempt.
    await mod.sendToSocket({ command: 'status' }, 200).catch(() => {});

    const expectedDir = join(isolated, `copilot-companion-uid${process.getuid()}`);
    assert.ok(existsSync(expectedDir), `expected runtime dir at ${expectedDir}`);
    const st = lstatSync(expectedDir);
    assert.ok(st.isDirectory(), `${expectedDir} must be a directory`);
    assert.equal(st.mode & 0o777, 0o700,
      `${expectedDir} must be 0o700, got ${(st.mode & 0o777).toString(8)}`);
  } finally {
    if (baseBefore === undefined) delete process.env.COPILOT_RUNTIME_BASE;
    else process.env.COPILOT_RUNTIME_BASE = baseBefore;
    try { rmSync(isolated, { recursive: true, force: true }); } catch {}
  }
});
