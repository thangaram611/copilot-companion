// prompt-digest.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Each test sets fixtures into a fresh tmpdir and points the module at it
// via env vars; the module reads them at call time.
async function withTempDirs(fn) {
  const promptDir = mkdtempSync(join(tmpdir(), 'digest-prompt-'));
  const digestDir = mkdtempSync(join(tmpdir(), 'digest-out-'));
  process.env.COPILOT_PROMPT_JSONL_DIR = promptDir;
  process.env.COPILOT_DIGEST_DIR = digestDir;
  try { return await fn({ promptDir, digestDir }); }
  finally {
    delete process.env.COPILOT_PROMPT_JSONL_DIR;
    delete process.env.COPILOT_DIGEST_DIR;
    try { rmSync(promptDir, { recursive: true, force: true }); } catch {}
    try { rmSync(digestDir, { recursive: true, force: true }); } catch {}
  }
}

function writeJsonl(dir, promptId, events) {
  const path = join(dir, `copilot-acp-${promptId}.jsonl`);
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, lines);
  return path;
}

// Force a fresh module import so env-var-derived constants pick up the new
// values. (The module reads env at import time for DIGEST_DIR/PROMPT_JSONL_DIR.)
async function freshImport() {
  return import(`./prompt-digest.mjs?ts=${Date.now()}${Math.random()}`);
}

test('renderDigest: assembles header + final message from streamed chunks', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { renderDigest, buildDigest } = await freshImport();
    const promptId = 'p-streamed';
    writeJsonl(promptDir, promptId, [
      { type: 'start', sessionId: 's1', promptId, ts: 1 },
      { type: 'message', text: 'Hello', ts: 2 },
      { type: 'message', text: ' ', ts: 3 },
      { type: 'message', text: 'world.', ts: 4 },
      { type: 'thought', text: 'internal reasoning — should be skipped', ts: 5 },
    ]);
    const md = buildDigest(promptId, {
      jobId: 'job-1', status: 'completed', mode: 'EXECUTE',
      template: 'general', thread: 'companion-job-1',
      startedAt: Date.now() - 5000, terminalAt: Date.now(),
      task: 'say hi',
    });
    assert.ok(md, 'digest content non-null');
    assert.match(md, /# Copilot job job-1 — digest/);
    assert.match(md, /\*\*Status:\*\* `completed`/);
    assert.match(md, /\*\*Template:\*\* general/);
    assert.match(md, /## Task/);
    assert.match(md, /say hi/);
    assert.match(md, /## Final \/ partial assistant message/);
    assert.match(md, /Hello world\./);
    assert.doesNotMatch(md, /internal reasoning/);
  });
});

test('extractAssistantMessage: elides interleaved /fleet sub-agent stream window', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-interleave';
    writeJsonl(promptDir, promptId, [
      // Parent intro
      { type: 'message', text: 'Dispatching reviewers. ', ts: 100 },
      // /fleet sub-agent dispatched at ts=200
      { type: 'tool_call', toolCallId: 's1', name: 'review', kind: 'other',
        input: { agent_type: 'reviewer', name: 'r1' }, ts: 200 },
      // Sub-agent streams interleave from 210 to 500 — this is the garbage
      { type: 'message', text: 'SUB-AGENT-NOISE-1', ts: 210 },
      { type: 'message', text: 'SUB-AGENT-NOISE-2', ts: 300 },
      // Sub-agent terminates at 500
      { type: 'tool_call_update', toolCallId: 's1', status: 'completed',
        outputPreview: 'r1 found nothing.', ts: 500 },
      // Parent conclusion (after window)
      { type: 'message', text: 'All reviewers done. RUBBER-DUCK: clean.', ts: 600 },
    ]);
    const md = buildDigest(promptId, { jobId: 'job-fleet' });
    // Parent intro and conclusion present, sub-agent noise absent.
    assert.match(md, /Dispatching reviewers/);
    assert.match(md, /All reviewers done\. RUBBER-DUCK: clean\./);
    assert.doesNotMatch(md, /SUB-AGENT-NOISE/);
    // Explicit marker so the reader knows something was elided.
    assert.match(md, /interleaved \/fleet sub-agent streams omitted/);
  });
});

test('extractAssistantMessage: elides everything after fleet dispatch when sub-agent never terminates (timeout)', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-timeout-fleet';
    writeJsonl(promptDir, promptId, [
      { type: 'message', text: 'Starting parallel reviews.', ts: 100 },
      { type: 'tool_call', toolCallId: 's1', name: 'r', kind: 'other',
        input: { agent_type: 'reviewer', name: 'r1' }, ts: 200 },
      { type: 'message', text: 'INTERLEAVED-CRUFT', ts: 300 },
      // No tool_call_update — sub-agent is still running at digest time.
    ]);
    const md = buildDigest(promptId, { jobId: 'job-to', status: 'timeout' });
    assert.match(md, /Starting parallel reviews/);
    assert.doesNotMatch(md, /INTERLEAVED-CRUFT/);
    assert.match(md, /interleaved \/fleet sub-agent streams omitted/);
  });
});

test('extractSubAgents: pairs tool_call + update by toolCallId, surfaces outputPreview', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-fleet';
    writeJsonl(promptDir, promptId, [
      { type: 'start', promptId, ts: 1 },
      {
        type: 'tool_call', toolCallId: 'c1', name: 'Reviewing csp.ts', kind: 'other',
        locations: null,
        input: { description: 'Review csp.ts', agent_type: 'reviewer', name: 'csp-reviewer', prompt: '...' },
        ts: 2,
      },
      {
        type: 'tool_call', toolCallId: 'c2', name: 'Reviewing dev.ts', kind: 'other',
        locations: null,
        input: { description: 'Review dev.ts', agent_type: 'reviewer', name: 'dev-reviewer', prompt: '...' },
        ts: 3,
      },
      {
        type: 'tool_call_update', toolCallId: 'c1', status: 'completed',
        outputPreview: 'csp.ts: BLOCKING — frame-ancestors has trailing space.',
        name: 'Reviewing csp.ts', kind: 'other', ts: 4,
      },
      // c2 has no update → still running
    ]);
    const md = buildDigest(promptId, { jobId: 'job-2', status: 'timeout' });
    assert.match(md, /## Sub-agent reports \(\/fleet\)/);
    assert.match(md, /### `csp-reviewer` — completed/);
    assert.match(md, /\*Review csp\.ts\*/);
    assert.match(md, /frame-ancestors has trailing space/);
    assert.match(md, /### `dev-reviewer` — running/);
    assert.match(md, /\(no report yet — still running\)/);
  });
});

test('extractFiles: deduplicates source paths and counts touches', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-files';
    writeJsonl(promptDir, promptId, [
      { type: 'tool_call', toolCallId: 'a', name: 'view', kind: 'read',
        locations: [{ path: '/repo/csp.ts' }], input: {}, ts: 1 },
      { type: 'tool_call', toolCallId: 'b', name: 'view', kind: 'read',
        locations: [{ path: '/repo/csp.ts' }], input: {}, ts: 2 },
      { type: 'tool_call', toolCallId: 'c', name: 'view', kind: 'read',
        locations: [{ path: '/repo/dev.ts' }], input: {}, ts: 3 },
      { type: 'tool_call', toolCallId: 'd', name: 'edit', kind: 'execute',
        locations: [{ path: '/repo/csp.ts' }], input: {}, ts: 4 },
      // No locations → ignored
      { type: 'tool_call', toolCallId: 'e', name: 'shell', kind: 'execute',
        locations: null, input: {}, ts: 5 },
    ]);
    const md = buildDigest(promptId, { jobId: 'job-3' });
    assert.match(md, /## Source files touched/);
    assert.match(md, /`\/repo\/csp\.ts` \(3x\)/);
    assert.match(md, /`\/repo\/dev\.ts`(?! \()/); // count 1 → no (Nx) suffix
    assert.doesNotMatch(md, /## Other paths explored/);
  });
});

test('extractFiles: splits node_modules + bare directories into "Other paths" with tight cap', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-files-split';
    writeJsonl(promptDir, promptId, [
      { type: 'tool_call', toolCallId: '1', kind: 'read', name: 'view', input: {}, ts: 1,
        locations: [{ path: '/repo/src/app.ts' }] },
      { type: 'tool_call', toolCallId: '2', kind: 'read', name: 'view', input: {}, ts: 2,
        locations: [{ path: '/repo/src/utils' }] },   // bare directory → other
      { type: 'tool_call', toolCallId: '3', kind: 'read', name: 'view', input: {}, ts: 3,
        locations: [{ path: '/repo/node_modules/.pnpm/foo@1.0.0/package.json' }] }, // dep → other
      { type: 'tool_call', toolCallId: '4', kind: 'read', name: 'view', input: {}, ts: 4,
        locations: [{ path: '/repo/dist/bundle.js' }] }, // build artifact → other
    ]);
    const md = buildDigest(promptId, { jobId: 'job-split' });
    // Source section: just app.ts
    assert.match(md, /## Source files touched\n\n- `\/repo\/src\/app\.ts`/);
    // Other section: all three non-source paths
    assert.match(md, /## Other paths explored/);
    assert.match(md, /`\/repo\/src\/utils`/);
    assert.match(md, /`\/repo\/node_modules\/\.pnpm\/foo@1\.0\.0\/package\.json`/);
    assert.match(md, /`\/repo\/dist\/bundle\.js`/);
  });
});

test('extractFailedCalls: surfaces failed call name + verbatim error preview', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-failed';
    writeJsonl(promptDir, promptId, [
      { type: 'tool_call', toolCallId: 't1', kind: 'read',
        name: "Searching for 'proxyRes|writeHead'", input: {}, ts: 1 },
      { type: 'tool_call', toolCallId: 't2', kind: 'execute',
        name: 'Running npm test', input: {}, ts: 2 },
      { type: 'tool_call_update', toolCallId: 't1', status: 'failed',
        outputPreview: 'rg: /repo/node_modules/foo: No such file or directory (os error 2)', ts: 3 },
      { type: 'tool_call_update', toolCallId: 't2', status: 'completed',
        outputPreview: 'all tests passed', ts: 4 },
    ]);
    const md = buildDigest(promptId, { jobId: 'job-failed' });
    assert.match(md, /## Failed tool calls/);
    assert.match(md, /`read` — \*\*Searching for 'proxyRes\|writeHead'\*\*/);
    assert.match(md, /> rg: \/repo\/node_modules\/foo: No such file/);
    // Successful t2 should NOT show up
    assert.doesNotMatch(md, /Running npm test/);
  });
});

test('extractFailedCalls: section omitted when no failures', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-no-failed';
    writeJsonl(promptDir, promptId, [
      { type: 'tool_call', toolCallId: 'x', kind: 'read', name: 'view', input: {}, ts: 1 },
      { type: 'tool_call_update', toolCallId: 'x', status: 'completed', ts: 2 },
    ]);
    const md = buildDigest(promptId, { jobId: 'job-nf' });
    assert.doesNotMatch(md, /## Failed tool calls/);
  });
});

test('extractToolStats: counts by kind, includes failed counts and sub-agent invocations', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-tools';
    writeJsonl(promptDir, promptId, [
      { type: 'tool_call', toolCallId: '1', kind: 'read', name: 'view', input: {}, ts: 1 },
      { type: 'tool_call', toolCallId: '2', kind: 'read', name: 'view', input: {}, ts: 2 },
      { type: 'tool_call', toolCallId: '3', kind: 'execute', name: 'shell', input: {}, ts: 3 },
      { type: 'tool_call', toolCallId: '4', kind: 'other', name: 'fleet',
        input: { agent_type: 'reviewer', name: 'r1' }, ts: 4 },
      { type: 'tool_call_update', toolCallId: '3', status: 'failed', name: 'shell', ts: 5 },
      { type: 'tool_call_update', toolCallId: '1', status: 'completed', name: 'view', ts: 6 },
    ]);
    const md = buildDigest(promptId, { jobId: 'job-4' });
    assert.match(md, /## Tool-call summary/);
    assert.match(md, /`read`: 2/);
    assert.match(md, /`execute`: 1 \(1 failed\)/);
    assert.match(md, /`other`: 1/);
    assert.match(md, /sub-agent invocations: 1/);
  });
});

test('extractTodos: uses the latest plan event as snapshot', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-todos';
    writeJsonl(promptDir, promptId, [
      { type: 'plan', entries: [
        { content: 'A', status: 'in_progress' },
        { content: 'B', status: 'pending' },
      ], ts: 1 },
      { type: 'plan', entries: [
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'completed' },
      ], ts: 2 },
    ]);
    const md = buildDigest(promptId, { jobId: 'job-5' });
    assert.match(md, /## Todos \(latest snapshot\)/);
    assert.match(md, /- \[x\] A \*\(completed\)\*/);
    assert.match(md, /- \[x\] B \*\(completed\)\*/);
    // Older snapshot's in_progress / pending should NOT appear.
    assert.doesNotMatch(md, /- \[~\] A/);
  });
});

test('buildDigest: returns null when jsonl is missing', async () => {
  await withTempDirs(async () => {
    const { buildDigest } = await freshImport();
    assert.equal(buildDigest('p-missing', { jobId: 'job-6' }), null);
    assert.equal(buildDigest(null, { jobId: 'job-6' }), null);
  });
});

test('writeDigest: writes file to digestPath and returns path', async () => {
  await withTempDirs(async ({ promptDir, digestDir }) => {
    const { writeDigest, digestPath } = await freshImport();
    const promptId = 'p-write';
    writeJsonl(promptDir, promptId, [
      { type: 'message', text: 'done', ts: 1 },
    ]);
    const path = writeDigest(promptId, { jobId: 'job-7', status: 'completed' });
    assert.ok(path, 'returns path');
    assert.equal(path, digestPath('job-7'));
    assert.ok(existsSync(path), 'file exists');
    const content = readFileSync(path, 'utf8');
    assert.match(content, /Copilot job job-7/);
    assert.match(content, /done/);
  });
});

test('writeDigest: writes nothing (returns null) when jobId is absent', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { writeDigest } = await freshImport();
    const promptId = 'p-no-jobid';
    writeJsonl(promptDir, promptId, [
      { type: 'message', text: 'orphan', ts: 1 },
    ]);
    assert.equal(writeDigest(promptId, {}), null);
  });
});

test('renderDigest: truncates oversized assistant message with marker', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-big';
    const big = 'x'.repeat(20_000);
    writeJsonl(promptDir, promptId, [
      { type: 'message', text: big, ts: 1 },
    ]);
    const md = buildDigest(promptId, { jobId: 'job-8' });
    assert.match(md, /\[truncated\]/);
    // Should not contain the full 20k payload
    assert.ok(md.length < 20_000, 'digest is bounded');
  });
});

test('renderDigest: skips a section when there is no data for it', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-empty';
    writeJsonl(promptDir, promptId, [
      { type: 'start', promptId, ts: 1 },
    ]);
    const md = buildDigest(promptId, { jobId: 'job-9' });
    assert.doesNotMatch(md, /## Final \/ partial assistant message/);
    assert.doesNotMatch(md, /## Sub-agent reports/);
    assert.doesNotMatch(md, /## Failed tool calls/);
    assert.doesNotMatch(md, /## Source files touched/);
    assert.doesNotMatch(md, /## Other paths explored/);
    assert.doesNotMatch(md, /## Tool-call summary/);
    assert.doesNotMatch(md, /## Todos/);
    // Header must still render.
    assert.match(md, /# Copilot job job-9 — digest/);
  });
});
