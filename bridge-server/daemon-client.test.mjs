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

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, lstatSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

// Defensive: a developer with these vars exported in their shell would
// get misleading test results. Strip them at the test-file level.
// XDG_RUNTIME_DIR included because _runtimeDirBase() consults it; on a
// Linux CI host with XDG_RUNTIME_DIR set, our COPILOT_RUNTIME_BASE
// override still wins (it's checked first), but stripping XDG removes
// the dependency on that ordering and avoids surprises if precedence
// is ever reordered.
before(() => {
  for (const k of ['COPILOT_SOCKET_PATH', 'COPILOT_QUEUE_PATH', 'XDG_RUNTIME_DIR']) {
    delete process.env[k];
  }
});

// Helper: cache-bust dynamic import so SOCKET_PATH captures the per-test env.
function freshImport() {
  return import(`./daemon-client.mjs?cb=${Math.random()}`);
}

function withIsolatedBase(fn) {
  const before = process.env.COPILOT_RUNTIME_BASE;
  const isolated = mkdtempSync(join(tmpdir(), 'sendto-test-'));
  process.env.COPILOT_RUNTIME_BASE = isolated;
  return Promise.resolve(fn(isolated)).finally(() => {
    if (before === undefined) delete process.env.COPILOT_RUNTIME_BASE;
    else process.env.COPILOT_RUNTIME_BASE = before;
    try { rmSync(isolated, { recursive: true, force: true }); } catch {}
  });
}

test('sendToSocket establishes runtime dir at 0o700 before connect', { skip: typeof process.getuid !== 'function' }, async () => {
  await withIsolatedBase(async (isolated) => {
    const mod = await freshImport();
    // No daemon is listening; the connect will fail. We don't care about
    // that — we care that the runtime dir got verified along the way.
    await mod.sendToSocket({ command: 'status' }, 200).catch(() => {});

    const expectedDir = join(isolated, `copilot-companion-uid${process.getuid()}`);
    assert.ok(existsSync(expectedDir), `expected runtime dir at ${expectedDir}`);
    const st = lstatSync(expectedDir);
    assert.ok(st.isDirectory(), `${expectedDir} must be a directory`);
    assert.equal(st.mode & 0o777, 0o700,
      `${expectedDir} must be 0o700, got ${(st.mode & 0o777).toString(8)}`);
  });
});

// This test is the *load-bearing* one — it asserts ORDERING (verification
// fires BEFORE the connect attempt), not just outcome (dir exists eventually).
//
// Trick: plant a hostile symlink at the runtime dir path BEFORE calling
// sendToSocket. ensureRuntimeDir's invariant 1 (lstat → isDirectory) must
// reject and propagate the throw out of sendToSocket. If the verification
// were missing or were called AFTER the connect, the symlink wouldn't be
// caught and the connect would proceed against an attacker-controllable
// path. So a passing test here proves "verified before any connect attempt."
test('sendToSocket rejects when runtime dir path is a hostile symlink (ordering)', { skip: typeof process.getuid !== 'function' }, async () => {
  await withIsolatedBase(async (isolated) => {
    // Plant a symlink to /tmp at the predictable runtime dir path.
    const dir = join(isolated, `copilot-companion-uid${process.getuid()}`);
    symlinkSync('/tmp', dir);

    const mod = await freshImport();
    // The verification MUST throw before any net.connect happens. Failure
    // shape: an Error whose message includes the offending path, NOT a
    // socket connect error like ECONNREFUSED.
    await assert.rejects(
      () => mod.sendToSocket({ command: 'status' }, 200),
      (err) => {
        // Tight assertion: the error must be from ensureRuntimeDir (path in
        // message), not from the socket layer. Catches the false-pass where
        // a regression moves ensureRuntimeDir AFTER connect and the connect
        // fails first with a different error.
        if (!(err instanceof Error)) return false;
        if (!err.message.includes(dir)) return false;
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') return false;
        return /not a directory|symlink|regular file/i.test(err.message);
      },
    );
  });
});
