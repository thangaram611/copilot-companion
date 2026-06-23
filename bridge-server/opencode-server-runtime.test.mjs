import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveOpenCodeAdapter,
  openCodeServerActive,
  resolveOpenCodeServerModel,
  openCodeServerPromptId,
  createTurnAccumulator,
  ensureOpenCodeServer,
  createOpenCodeSession,
  startOpenCodeServerPrompt,
  abortOpenCodeSession,
  getOpenCodeSessionStatus,
  loadOpenCodeTranscript,
  openOpenCodeTurnWatcher,
  openCodeServerPoolSnapshot,
  _setForTest,
  _resetForTest,
} from './opencode-server-runtime.mjs';

let regDir;
beforeEach(() => {
  regDir = mkdtempSync(join(tmpdir(), 'oc-server-reg-'));
  process.env.AGENT_OPENCODE_SERVER_REGISTRY = join(regDir, 'servers.json');
  _resetForTest();
});
afterEach(() => {
  _resetForTest();
  delete process.env.AGENT_OPENCODE_SERVER_REGISTRY;
  rmSync(regDir, { recursive: true, force: true });
});

const SID = 'ses_abc';

// An async-iterable SSE source matching the real openEventStream contract
// (async function returning an async iterable of decoded text chunks).
function sseStream(frames) {
  return async () => (async function* () {
    for (const f of frames) yield f;
  })();
}
function frame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// --- adapter selection / model ---------------------------------------------

test('adapter resolves cli by default and server when configured', () => {
  assert.equal(resolveOpenCodeAdapter({}), 'cli');
  assert.equal(openCodeServerActive({}), false);
  assert.equal(resolveOpenCodeAdapter({ OPENCODE_RUNTIME_ADAPTER: 'server' }), 'server');
  assert.equal(openCodeServerActive({ OPENCODE_RUNTIME_ADAPTER: 'SERVER' }), true);
  assert.equal(resolveOpenCodeAdapter({ OPENCODE_RUNTIME_ADAPTER: 'nonsense' }), 'cli');
});

test('model splits provider/model and rejects malformed values', () => {
  assert.equal(resolveOpenCodeServerModel({}), null);
  assert.deepEqual(resolveOpenCodeServerModel({ AGENT_COMPANION_OPENCODE_MODEL: 'ollama-cloud/gpt-oss:120b' }), { providerID: 'ollama-cloud', modelID: 'gpt-oss:120b' });
  assert.equal(resolveOpenCodeServerModel({ AGENT_COMPANION_OPENCODE_MODEL: 'noslash' }), null);
  assert.equal(resolveOpenCodeServerModel({ AGENT_COMPANION_OPENCODE_MODEL: '/leading' }), null);
  assert.equal(resolveOpenCodeServerModel({ AGENT_COMPANION_OPENCODE_MODEL: 'trailing/' }), null);
});

test('promptId encodes reply generation', () => {
  assert.equal(openCodeServerPromptId('j1'), 'opencode-j1');
  assert.equal(openCodeServerPromptId('j1', 2), 'opencode-j1-r2');
});

// --- pure accumulator ------------------------------------------------------

function feed(acc, frames) {
  for (const f of frames) acc.push(f);
  acc.flush();
}

test('accumulator assembles assistant text and resolves completed on session.idle', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.updated', properties: { sessionID: SID, info: { role: 'assistant', id: 'msg1' } } }),
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'msg1', type: 'text', text: 'Hello ' } } }),
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p2', messageID: 'msg1', type: 'text', text: 'world' } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  assert.deepEqual(acc.terminal, { status: 'completed' });
  assert.equal(acc.snapshot().message, 'Hello world');
});

test('accumulator keeps tool-only turn non-empty via toolCalls', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 't1', messageID: 'msg1', type: 'tool', tool: 'bash', state: { input: { cmd: 'ls' } } } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  assert.equal(acc.terminal.status, 'completed');
  const snap = acc.snapshot();
  assert.equal(snap.message, '');
  assert.equal(snap.toolCalls.length, 1);
  assert.equal(snap.toolCalls[0].name, 'bash');
});

test('accumulator routes reasoning to thoughts, not message', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'r1', messageID: 'msg1', type: 'reasoning', text: 'thinking...' } } }),
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'msg1', type: 'text', text: 'answer' } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  const snap = acc.snapshot();
  assert.equal(snap.message, 'answer');
  assert.equal(snap.thoughts, 'thinking...');
});

test('accumulator maps abort to cancelled', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.updated', properties: { sessionID: SID, info: { role: 'assistant', id: 'msg1', error: { name: 'MessageAbortedError', message: 'aborted' } } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  assert.equal(acc.terminal.status, 'cancelled');
});

test('accumulator maps session.error to failed', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'session.error', properties: { sessionID: SID, error: { name: 'ProviderAuthError', message: 'no key' } } }),
  ]);
  assert.equal(acc.terminal.status, 'failed');
  assert.equal(acc.snapshot().error, 'no key');
});

test('accumulator ignores foreign sessions and global noise', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'server.heartbeat', properties: {} }),
    frame({ type: 'message.part.updated', properties: { sessionID: 'ses_other', part: { id: 'x', messageID: 'm', type: 'text', text: 'NOPE' } } }),
    frame({ type: 'session.idle', properties: { sessionID: 'ses_other' } }),
  ]);
  assert.equal(acc.terminal, null);
  assert.equal(acc.snapshot().message, '');
});

test('accumulator parses split frames across push boundaries', () => {
  const acc = createTurnAccumulator(SID);
  const f = frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'msg1', type: 'text', text: 'chunked' } } });
  acc.push(f.slice(0, 10));
  acc.push(f.slice(10));
  acc.push(frame({ type: 'session.idle', properties: { sessionID: SID } }));
  acc.flush();
  assert.equal(acc.terminal.status, 'completed');
  assert.equal(acc.snapshot().message, 'chunked');
});

// --- server pool -----------------------------------------------------------

function fakeChild(lines) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.unref = () => {};
  setImmediate(() => { for (const l of lines) child.stdout.emit('data', Buffer.from(l)); });
  return child;
}

test('ensureOpenCodeServer spawns once, parses boot URL, then reuses on healthy probe', async () => {
  let spawns = 0;
  _setForTest({
    spawnServer: () => { spawns++; return fakeChild(['Warning: unsecured\n', 'opencode server listening on http://127.0.0.1:4096\n']); },
    fetchJson: async (url) => url.includes('/global/health') ? { ok: true, data: { healthy: true } } : { ok: true, data: {} },
  });
  const a = await ensureOpenCodeServer();
  assert.equal(a.baseUrl, 'http://127.0.0.1:4096');
  assert.equal(spawns, 1);
  const b = await ensureOpenCodeServer();
  assert.equal(b.reused, true);
  assert.equal(spawns, 1); // healthy cache → no second spawn
  const snap = openCodeServerPoolSnapshot();
  assert.equal(snap.baseUrl, 'http://127.0.0.1:4096');
});

test('ensureOpenCodeServer rejects when the server exits before listening', async () => {
  _setForTest({
    spawnServer: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('close', 1));
      return child;
    },
  });
  await assert.rejects(() => ensureOpenCodeServer(), /exited before listening/);
});

// --- session ops (directory-scoped) ----------------------------------------

test('session ops thread the directory query param', async () => {
  const calls = [];
  _setForTest({
    fetchJson: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body });
      if (url.includes('/session/status')) return { ok: true, data: { [SID]: { type: 'busy' } } };
      if (url.endsWith('/session?directory=' + encodeURIComponent('/work'))) return { ok: true, data: { id: SID } };
      if (url.includes('/abort')) return { ok: true, data: true };
      return { ok: true, data: {} };
    },
  });
  const sid = await createOpenCodeSession({ baseUrl: 'http://h', directory: '/work', title: 't' });
  assert.equal(sid, SID);
  await startOpenCodeServerPrompt({ baseUrl: 'http://h', sessionId: SID, directory: '/work', prompt: 'hi', model: { providerID: 'p', modelID: 'm' } });
  const ab = await abortOpenCodeSession({ baseUrl: 'http://h', sessionId: SID, directory: '/work' });
  assert.equal(ab.aborted, true);
  const status = await getOpenCodeSessionStatus({ baseUrl: 'http://h', sessionId: SID, directory: '/work' });
  assert.equal(status, 'busy');
  assert.ok(calls.every((c) => c.url.includes('directory=')), 'every scoped call carries ?directory=');
  const prompt = calls.find((c) => c.url.includes('prompt_async'));
  assert.deepEqual(prompt.body.parts, [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(prompt.body.model, { providerID: 'p', modelID: 'm' });
});

test('session status reports idle when the session is absent from the map', async () => {
  _setForTest({ fetchJson: async () => ({ ok: true, data: {} }) });
  assert.equal(await getOpenCodeSessionStatus({ baseUrl: 'http://h', sessionId: SID }), 'idle');
});

test('loadOpenCodeTranscript extracts completed assistant text and tools', async () => {
  _setForTest({
    fetchJson: async () => ({ ok: true, data: [
      { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'q' }] },
      { info: { role: 'assistant', time: { created: 2, completed: 3 } }, parts: [
        { type: 'reasoning', text: 'hmm' },
        { type: 'tool', tool: 'edit', state: { input: { path: 'a' } } },
        { type: 'text', text: 'final answer' },
      ] },
    ] }),
  });
  const t = await loadOpenCodeTranscript({ baseUrl: 'http://h', sessionId: SID, directory: '/w' });
  assert.equal(t.completed, true);
  assert.equal(t.summary.message, 'final answer');
  assert.equal(t.summary.thoughts, 'hmm');
  assert.equal(t.summary.toolCalls.length, 1);
});

// --- watcher: edge / level / drop ------------------------------------------

test('watcher resolves completed from the SSE edge (session.idle)', async () => {
  _setForTest({
    openEventStream: sseStream([
      frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'm1', type: 'text', text: 'done' } } }),
      frame({ type: 'session.idle', properties: { sessionID: SID } }),
    ]),
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w' });
  const result = await watcher.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.message, 'done');
});

test('watcher level-check resolves terminal from transcript without waiting for SSE', async () => {
  // Stream yields nothing terminal; the level-check finds an already-completed turn.
  _setForTest({
    openEventStream: sseStream([]),
    fetchJson: async (url) => {
      if (url.includes('/session/status')) return { ok: true, data: {} }; // idle
      if (url.includes('/message')) return { ok: true, data: [
        { info: { role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ type: 'text', text: 'already done' }] },
      ] };
      return { ok: true, data: {} };
    },
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w', initialLevelCheck: true });
  const result = await watcher.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.message, 'already done');
});

test('watcher stream-drop falls back to transcript when the session is idle', async () => {
  _setForTest({
    openEventStream: sseStream([
      frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'm1', type: 'text', text: 'partial' } } }),
      // stream ends WITHOUT session.idle
    ]),
    fetchJson: async (url) => {
      if (url.includes('/session/status')) return { ok: true, data: {} }; // idle
      if (url.includes('/message')) return { ok: true, data: [
        { info: { role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ type: 'text', text: 'recovered' }] },
      ] };
      if (url.includes('/global/health')) return { ok: true, data: { healthy: true } };
      return { ok: true, data: {} };
    },
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w' });
  const result = await watcher.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.message, 'recovered');
});

test('watcher stream-drop maps a dead server to unreachable', async () => {
  _setForTest({
    openEventStream: sseStream([]),
    fetchJson: async (url) => {
      if (url.includes('/session/status')) return { ok: false, data: null };
      if (url.includes('/global/health')) return { ok: false, data: null };
      return { ok: false, data: null };
    },
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w' });
  const result = await watcher.done;
  assert.equal(result.status, 'unreachable');
});

test('watcher maps abort SSE to cancelled', async () => {
  _setForTest({
    openEventStream: sseStream([
      frame({ type: 'message.updated', properties: { sessionID: SID, info: { role: 'assistant', id: 'm1', error: { name: 'MessageAbortedError', message: 'stop' } } } }),
      frame({ type: 'session.idle', properties: { sessionID: SID } }),
    ]),
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w' });
  const result = await watcher.done;
  assert.equal(result.status, 'cancelled');
});

test('watcher honors timeout when no terminal arrives', async () => {
  _setForTest({
    // an open stream that never yields a terminal and never ends
    openEventStream: async () => (async function* () {
      await new Promise((r) => setTimeout(r, 1000));
    })(),
    fetchJson: async () => ({ ok: true, data: {} }),
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w', timeoutMs: 30 });
  const result = await watcher.done;
  assert.equal(result.status, 'timeout');
});
