import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildPromptInspection } from './prompt-inspect.mjs';

describe('buildPromptInspection', () => {
  it('summarizes tool activity, plan updates, and assistant output', () => {
    const events = [
      {
        type: 'tool_call',
        toolCallId: 't1',
        name: 'view',
        kind: 'read',
        input: { path: '/repo/src/index.ts', view_range: [1, 120] },
        ts: 1_000,
      },
      {
        type: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        outputPreview: 'export const value = 1;',
        name: 'view',
        ts: 2_000,
      },
      {
        type: 'tool_call',
        toolCallId: 't2',
        name: 'github-mcp-server-search_code',
        kind: 'search',
        input: { query: 'repo:cline/cline Tree-sitter OR tree-sitter path:src' },
        ts: 3_000,
      },
      {
        type: 'tool_call_update',
        toolCallId: 't2',
        status: 'failed',
        outputPreview: 'failed to search code with query',
        name: 'github-mcp-server-search_code',
        ts: 4_000,
      },
      {
        type: 'plan',
        entries: [
          { status: 'in_progress', title: 'Inspect parser files' },
          { status: 'pending', title: 'Check callsites' },
        ],
        ts: 5_000,
      },
      { type: 'message', text: 'Found repeated failures. ', ts: 6_000 },
      { type: 'message', text: 'Need caller-side recovery.', ts: 7_000 },
      { type: 'stuck', reason: 'failures:3_failed_tool_calls:github-mcp-server-search_code', ts: 8_000 },
    ];

    const inspection = buildPromptInspection(
      {
        promptId: 'prompt-1',
        sessionId: 'session-1',
        cwd: '/repo',
        status: 'stuck',
        startedAt: 0,
        terminalAt: 8_000,
        lastEventAt: 8_000,
        msSinceLastEvent: 0,
        retentionExpiresAt: 10_000,
        stuckReason: 'failures:3_failed_tool_calls:github-mcp-server-search_code',
        stuckDetail: 'err="failed to search code with query"',
      },
      events,
      { includeTimeline: true, limit: 10 },
    );

    assert.equal(inspection.status, 'stuck');
    assert.equal(inspection.cwd, '/repo');
    assert.equal(inspection.failedTools[0], 'github-mcp-server-search_code');
    assert.match(inspection.latestPlan, /Inspect parser files/);
    assert.match(inspection.activity[0], /^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] read file \/repo\/src\/index\.ts/);
    assert.match(inspection.activity[1], /web_search .*-> failed:/);
    assert.match(inspection.activity[2], /plan update:/);
    assert.match(inspection.activity[3], /copilot output: "Found repeated failures\. Need caller-side recovery\."/);
    assert.match(inspection.activity[4], /supervisor marked prompt stuck:/);
  });

  it('applies the requested activity limit to the tail of the timeline', () => {
    const events = [];
    for (let i = 0; i < 5; i++) {
      events.push({ type: 'message', text: `chunk ${i}`, ts: i + 1 });
      events.push({ type: 'plan', entries: [{ title: `step ${i}` }], ts: i + 100 });
    }

    const inspection = buildPromptInspection(
      {
        promptId: 'prompt-2',
        sessionId: 'session-2',
        cwd: '/repo',
        status: 'completed',
        startedAt: 0,
        terminalAt: 500,
        lastEventAt: 500,
        msSinceLastEvent: 0,
        retentionExpiresAt: 1_000,
      },
      events,
      { includeTimeline: true, limit: 3 },
    );

    assert.equal(inspection.activity.length, 3);
    assert.equal(inspection.activityTruncated, true);
    assert.match(inspection.activity[0], /step 3|chunk 4/);
    assert.match(inspection.activity[2], /step 4/);
  });
});
