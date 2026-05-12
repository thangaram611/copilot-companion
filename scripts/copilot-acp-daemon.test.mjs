// scripts/copilot-acp-daemon.test.mjs
// Unit tests for the per-session prompt mutex in SessionManager.startPromptBg
// and the hardened drain in SessionManager.replyPrompt. These tests pin the
// bug-fix invariant: a non-terminal prompt (running OR cancelling) must block
// any second prompt-bg on the same Copilot sessionId, and replyPrompt must
// refuse to restart when the prior turn never drains.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SessionManager,
  TERMINAL_STATUSES,
  REPLY_DRAIN_TIMEOUT_MS,
} from './copilot-acp-daemon.mjs';

// Stub AcpConnection: pretends to be alive; sendPrompt returns a controllable
// promise (call resolveSendPrompt / rejectSendPrompt to settle it) so the
// test can pin the prompt's lifecycle state. cancelSession is a no-op.
function makeFakeConnection() {
  let resolveSend = null;
  let rejectSend = null;
  return {
    child: { exitCode: null, pid: 1, kill() {} },
    initialized: true,
    dead: false,
    isAlive() { return true; },
    sendPrompt(_sid, _text, _writeEvent) {
      return new Promise((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
      });
    },
    cancelSession() { return true; },
    kill() {},
    resolveSend(value)  { if (resolveSend) resolveSend(value); },
    rejectSend(err)     { if (rejectSend) rejectSend(err); },
  };
}

// Spin up a SessionManager with a fake connection + one pre-registered
// session, plus tidy teardown so node:test doesn't leak unref'd timers.
function makeManager(sessionId = 'sid-A', cwd = '/tmp') {
  const manager = new SessionManager();
  const conn = makeFakeConnection();
  manager.connection = conn;
  manager.sessions.set(sessionId, { cwd, promptCount: 0, createdAt: Date.now() });
  const teardown = async () => {
    // Settle any dangling sendPrompt first so the daemon's `.then` handler
    // runs (it calls _resetInactivityTimer and writeEvent). We then drain
    // microtasks before clearing timers, otherwise the post-resolve handler
    // would re-arm inactivityTimer after we cleared it and keep Node alive
    // for the full 15-min INACTIVITY_TIMEOUT_MS.
    conn.resolveSend({ stopReason: 'end_turn' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    if (manager.inactivityTimer) clearTimeout(manager.inactivityTimer);
    if (manager.superviseTimer) clearInterval(manager.superviseTimer);
    if (manager._livenessTimer) clearInterval(manager._livenessTimer);
    manager.inactivityTimer = null;
    manager.superviseTimer = null;
    manager._livenessTimer = null;
    manager.inFlightPrompts.clear();
  };
  return { manager, conn, teardown };
}

test('startPromptBg mutex rejects a second start while prior prompt is running', async (t) => {
  const { manager, teardown } = makeManager('sid-A');
  t.after(teardown);

  const first = await manager.startPromptBg('sid-A', 'hello');
  const firstState = manager.inFlightPrompts.get(first.promptId);
  assert.equal(firstState.status, 'running', 'first prompt should be running');

  await assert.rejects(
    () => manager.startPromptBg('sid-A', 'world'),
    (err) => {
      assert.equal(err.code, 'SESSION_BUSY', 'mutex must surface SESSION_BUSY code');
      assert.equal(err.existingPromptId, first.promptId, 'must report the in-flight promptId');
      assert.equal(err.sessionId, 'sid-A', 'must report the contested sessionId');
      return true;
    },
  );

  // Sanity: the original prompt is untouched.
  assert.equal(manager.inFlightPrompts.size, 1);
  assert.equal(manager.inFlightPrompts.get(first.promptId).status, 'running');
});

test('startPromptBg mutex still rejects while prior prompt is cancelling (no exemption)', async (t) => {
  const { manager, teardown } = makeManager('sid-B');
  t.after(teardown);

  const first = await manager.startPromptBg('sid-B', 'turn1');
  const state = manager.inFlightPrompts.get(first.promptId);

  // Simulate the post-cancel window where the prior collector is still
  // mapped in AcpConnection.sessionCollectors[sessionId]. cancelPrompt flips
  // state to 'cancelling' but the JSON-RPC promise has not yet resolved.
  manager.cancelPrompt(first.promptId);
  assert.equal(state.status, 'cancelling');
  assert.ok(!TERMINAL_STATUSES.has(state.status), 'cancelling must remain non-terminal');

  await assert.rejects(
    () => manager.startPromptBg('sid-B', 'turn2'),
    (err) => err.code === 'SESSION_BUSY' && err.existingPromptId === first.promptId,
    'mutex must still trip for cancelling prompts — this is the no-exemption invariant',
  );
});

test('replyPrompt returns drain-timeout error and does NOT call startPromptBg when the prior turn never drains', async (t) => {
  const { manager, conn, teardown } = makeManager('sid-C');
  t.after(teardown);

  const first = await manager.startPromptBg('sid-C', 'turn1');

  // Spy: capture any startPromptBg invocation that happens after the drain
  // cap fires. The hardened replyPrompt must NOT call it on timeout.
  let startCalledAfterTimeout = false;
  const originalStart = manager.startPromptBg.bind(manager);
  manager.startPromptBg = (...args) => {
    startCalledAfterTimeout = true;
    return originalStart(...args);
  };

  // Fast-forward the drain cap via fake timers. cancelSession is a no-op in
  // the fake, so state.status stays at 'cancelling' until the cap expires.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const replyP = manager.replyPrompt(first.promptId, 'follow-up');
  // Advance past the drain cap.
  t.mock.timers.tick(REPLY_DRAIN_TIMEOUT_MS + 50);
  const result = await replyP;
  t.mock.timers.reset();

  assert.equal(result.ok, false, 'replyPrompt must report failure on drain timeout');
  assert.match(result.reason, /reply timeout: prior turn did not drain/);
  assert.equal(startCalledAfterTimeout, false, 'startPromptBg must not be called on drain timeout');

  // The first prompt is left in 'cancelling' so the mutex would still block
  // anyone else from racing in on this session.
  const state = manager.inFlightPrompts.get(first.promptId);
  assert.equal(state.status, 'cancelling');
});
