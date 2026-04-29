// Unit tests for prompt-supervisor.mjs
// Run: node --test ~/.claude/copilot-companion/lib/prompt-supervisor.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor, pollSupervisor, DEFAULTS } from './prompt-supervisor.mjs';

// Non-zero base timestamp so `event.ts || Date.now()` in observe doesn't fall
// back to wall clock when we pass ts:0.
const T0 = 1_000_000;

function freshState() {
  return { lastEventAt: T0, startedAt: T0 };
}

function viewEvent(path, opts = {}) {
  return {
    type: 'tool_call',
    toolCallId: opts.toolCallId || 'tc_' + Math.random().toString(36).slice(2),
    name: opts.name || 'view ' + path,
    kind: opts.kind || 'read',
    input: { path, ...(opts.input || {}) },
    ts: opts.ts || T0,
  };
}

// ============================================================================
// F1 — Supervisor.observe (event-level)
// ============================================================================

describe('F1a — view loops: paginated reads do NOT trip', () => {
  it('view_range chunks across the same file produce distinct keys', () => {
    const sup = new Supervisor();
    const state = freshState();
    for (let i = 0; i < 6; i++) {
      const ev = viewEvent('/some/file.mjs', { input: { view_range: [i * 100 + 1, (i + 1) * 100] }, ts: T0 + i });
      const r = sup.observe(ev, state);
      assert.equal(r.action, 'ok', `paginated read #${i + 1} should not trip`);
    }
  });

  it('ACP-style line+limit chunks produce distinct keys', () => {
    const sup = new Supervisor();
    const state = freshState();
    for (let i = 0; i < 6; i++) {
      const ev = viewEvent('/x.mjs', { input: { line: i * 50 + 1, limit: 50 }, ts: T0 + i });
      const r = sup.observe(ev, state);
      assert.equal(r.action, 'ok');
    }
  });
});

describe('F1b — view loops: identical reads DO trip', () => {
  it('6+ identical view_range calls trip with autoCancelOk:false', () => {
    const sup = new Supervisor();
    const state = freshState();
    let r;
    let stuckAt = -1;
    for (let i = 0; i < 8; i++) {
      r = sup.observe(viewEvent('/x.mjs', { input: { view_range: [1, 100] }, ts: T0 + i }), state);
      if (r.action === 'trip') { stuckAt = i + 1; break; }
    }
    assert.equal(stuckAt, 6);
    assert.match(r.reason, /^loop:identical_view:/);
    assert.equal(r.autoCancelOk, false);
  });
});

describe('F1c — search/grep (kind:read with pattern/glob) is NOT a view', () => {
  it('repeated different greps do NOT trip the view loop', () => {
    const sup = new Supervisor();
    const state = freshState();
    for (let i = 0; i < 8; i++) {
      const ev = {
        type: 'tool_call',
        toolCallId: 'grep_' + i,
        name: `Searching for 'foo${i}'`,
        kind: 'read',
        input: { pattern: `foo${i}`, glob: '**/*.ts' },
        ts: T0 + i,
      };
      const r = sup.observe(ev, state);
      assert.equal(r.action, 'ok', `grep #${i + 1} should not trip view loop`);
    }
  });
});

describe('F1d — generic tool_call hash loop', () => {
  it('3+ identical non-view tool_calls trip with autoCancelOk:false', () => {
    const sup = new Supervisor();
    const state = freshState();
    const ev = { type: 'tool_call', name: 'shell', kind: 'shell', input: { cmd: 'ls' }, ts: T0 };
    let r;
    for (let i = 0; i < 5; i++) {
      r = sup.observe({ ...ev, toolCallId: 'sh_' + i }, state);
      if (r.action === 'trip') break;
    }
    assert.equal(r.action, 'trip');
    assert.match(r.reason, /^loop:identical_tool_call:/);
    assert.equal(r.autoCancelOk, false);
  });
});

describe('F1e — failure streaks (per-tool)', () => {
  it('3 consecutive failures of the SAME tool trip with the tool name', () => {
    const sup = new Supervisor();
    const state = freshState();
    let r;
    for (let i = 0; i < 4; i++) {
      r = sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + i }, state);
      if (r.action === 'trip') break;
    }
    assert.equal(r.action, 'trip');
    assert.match(r.reason, /^failures:\d+_failed_tool_calls:web_search$/);
  });

  it('a completed tool_call_update on the same tool resets its counter', () => {
    const sup = new Supervisor();
    const state = freshState();
    sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 }, state);
    sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + 1 }, state);
    sup.observe({ type: 'tool_call_update', status: 'completed', name: 'web_search', ts: T0 + 2 }, state);
    const r1 = sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + 3 }, state);
    const r2 = sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + 4 }, state);
    assert.equal(r1.action, 'ok');
    assert.equal(r2.action, 'ok');
  });

  it('3 failures spread across 3 different tools do NOT trip (regression — mixed-tool bursts)', () => {
    const sup = new Supervisor();
    const state = freshState();
    const r1 = sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 }, state);
    const r2 = sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_fetch', ts: T0 + 1 }, state);
    const r3 = sup.observe({ type: 'tool_call_update', status: 'failed', name: 'grep', ts: T0 + 2 }, state);
    assert.equal(r1.action, 'ok');
    assert.equal(r2.action, 'ok');
    assert.equal(r3.action, 'ok');
  });

  it('same-tool streak survives unrelated tools succeeding in between', () => {
    const sup = new Supervisor();
    const state = freshState();
    sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 }, state);
    sup.observe({ type: 'tool_call_update', status: 'completed', name: 'grep', ts: T0 + 1 }, state);
    sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + 2 }, state);
    sup.observe({ type: 'tool_call_update', status: 'completed', name: 'view', ts: T0 + 3 }, state);
    const r = sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + 4 }, state);
    assert.equal(r.action, 'trip');
    assert.match(r.reason, /:web_search$/);
  });
});

describe('F1f — negative output previews (windowed)', () => {
  it('3 negatives clustered inside the window trip', () => {
    const sup = new Supervisor();
    const state = freshState();
    let r;
    for (const preview of ['permission denied', 'no matches', 'not found']) {
      r = sup.observe({ type: 'tool_call_update', status: 'completed', outputPreview: preview, ts: T0 }, state);
      if (r.action === 'trip') break;
    }
    assert.equal(r.action, 'trip');
    assert.match(r.reason, /^negatives:\d+_of_\d+_recent_previews/);
  });

  it('scattered negatives across a long session do NOT trip (regression)', () => {
    // 2 negatives per every 6-update window is below the trip-3 threshold.
    // Previously this tripped because the counter never decayed.
    const sup = new Supervisor();
    const state = freshState();
    const previews = [
      'no matches', 'ok', 'ok', 'ok', 'ok', 'ok',
      'not found', 'ok', 'ok', 'ok', 'ok', 'ok',
      'permission denied', 'ok', 'ok', 'ok', 'ok', 'ok',
    ];
    for (const preview of previews) {
      const r = sup.observe({ type: 'tool_call_update', status: 'completed', outputPreview: preview, ts: T0 }, state);
      assert.equal(r.action, 'ok', `scattered negative "${preview}" should not trip`);
    }
  });
});

describe('F1g — tool_calls-without-message (exploration trip)', () => {
  it('80 tool_calls without intervening message/thought trip', () => {
    const sup = new Supervisor();
    const state = freshState();
    let r;
    let trippedAt = -1;
    for (let i = 0; i < 90; i++) {
      r = sup.observe({ type: 'tool_call', toolCallId: 't_' + i, name: `distinct_${i}`, kind: 'read', input: { path: `/f_${i}` }, ts: T0 + i }, state);
      if (r.action === 'trip' && /exploring:/.test(r.reason)) { trippedAt = i + 1; break; }
    }
    assert.equal(trippedAt, 80);
    assert.match(r.reason, /^exploring:/);
  });

  it('50-deep fan-out wave does NOT trip (regression — fleet+rubber-duck waves)', () => {
    // 5 task sub-agents × 10 inner tool_calls = 50 events without an outer
    // message. The old 25 limit tripped on Copilot\'s own audit run. 80 leaves
    // clear headroom for realistic fan-out.
    const sup = new Supervisor();
    const state = freshState();
    for (let i = 0; i < 50; i++) {
      const r = sup.observe({ type: 'tool_call', toolCallId: 't_' + i, name: `distinct_${i}`, kind: 'read', input: { path: `/f_${i}` }, ts: T0 + i }, state);
      assert.equal(r.action, 'ok', `event ${i + 1} in fan-out wave should not trip`);
    }
  });

  it('thought events reset the exploration counter', () => {
    const sup = new Supervisor();
    const state = freshState();
    for (let i = 0; i < 70; i++) {
      sup.observe({ type: 'tool_call', toolCallId: 't_' + i, name: `distinct_${i}`, kind: 'read', input: { path: `/f_${i}` }, ts: T0 + i }, state);
    }
    sup.observe({ type: 'thought', text: 'synthesizing', ts: T0 + 70 }, state);
    for (let i = 71; i < 78; i++) {
      const r = sup.observe({ type: 'tool_call', toolCallId: 't_' + i, name: `post_${i}`, kind: 'read', input: { path: `/f_${i}` }, ts: T0 + i }, state);
      assert.equal(r.action, 'ok');
    }
  });
});

describe('F1h — long-pending tool_calls do NOT trip (handled by poll-level silence instead)', () => {
  it('a tool_call pending for 5 minutes with sibling events stays ok', () => {
    // Regression: a `task` sub-agent spawn or slow web_search can stay pending
    // for minutes while its internal work produces other ACP events. The
    // supervisor must not cancel on that alone — pollSupervisor's silenceTripMs
    // catches the case where the whole prompt truly stops producing events.
    const sup = new Supervisor();
    const state = freshState();
    sup.observe({ type: 'tool_call', toolCallId: 'tc_task', name: 'task', input: { prompt: 'research X' }, ts: T0 }, state);
    for (let i = 0; i < 30; i++) {
      const r = sup.observe({ type: 'thought', text: `tick ${i}`, ts: T0 + i * 10_000 }, state);
      assert.equal(r.action, 'ok', `tick ${i} should not trip`);
    }
    const r = sup.observe({ type: 'thought', text: 'still going', ts: T0 + 300_000 }, state);
    assert.equal(r.action, 'ok');
  });
});

// ============================================================================
// F2 — pollSupervisor (tiered poll-level)
// ============================================================================

describe('F2 — pollSupervisor tiered thresholds (post-first-event)', () => {
  function makeRunningState() {
    return { lastEventAt: 0, startedAt: 0, _hasFirstRealEvent: true, _lastAlertTs: null };
  }

  it('returns ok under silenceAlertMs (e.g., 60s)', () => {
    const r = pollSupervisor(makeRunningState(), 60_000);
    assert.equal(r.action, 'ok');
    assert.equal(r.tier, null);
  });

  it('returns alert (tier 1) between silenceAlertMs and silenceTripMs (e.g., 150s)', () => {
    const r = pollSupervisor(makeRunningState(), 150_000);
    assert.equal(r.action, 'alert');
    assert.equal(r.tier, 1);
    assert.match(r.reason, /^silence:\d+s$/);
  });

  it('returns trip (tier 2) past silenceTripMs (e.g., 250s)', () => {
    const r = pollSupervisor(makeRunningState(), 250_000);
    assert.equal(r.action, 'trip');
    assert.equal(r.tier, 2);
    assert.match(r.reason, /^silence:\d+s$/);
  });

  it('trip tier wins over alert tier at the trip-threshold boundary', () => {
    const r = pollSupervisor(makeRunningState(), 241_000);
    assert.equal(r.action, 'trip');
    assert.equal(r.tier, 2);
  });
});

describe('F2 — pollSupervisor first-event branch', () => {
  function makePreFirstEventState() {
    return { lastEventAt: 0, startedAt: 0, _hasFirstRealEvent: false, _lastAlertTs: null };
  }

  it('uses firstEventSilenceAlertMs (180s) as alert threshold', () => {
    assert.equal(pollSupervisor(makePreFirstEventState(), 170_000).action, 'ok');
    const r = pollSupervisor(makePreFirstEventState(), 200_000);
    assert.equal(r.action, 'alert');
    assert.match(r.reason, /:first_event$/);
  });

  it('uses firstEventSilenceTripMs (360s) as trip threshold', () => {
    const r = pollSupervisor(makePreFirstEventState(), 400_000);
    assert.equal(r.action, 'trip');
    assert.match(r.reason, /:first_event$/);
  });
});

// ============================================================================
// F3 — cooldown
// ============================================================================

describe('F3 — alertCooldownMs dedupe', () => {
  it('a second poll within cooldown returns ok instead of re-alerting', () => {
    const state = { lastEventAt: 0, startedAt: 0, _hasFirstRealEvent: true, _lastAlertTs: null };

    const r1 = pollSupervisor(state, 150_000);
    assert.equal(r1.action, 'alert');
    state._lastAlertTs = 150_000; // daemon sets this after emitting

    const r2 = pollSupervisor(state, 180_000);
    assert.equal(r2.action, 'ok', 'within cooldown → no re-alert');

    const r3 = pollSupervisor(state, 215_000);
    assert.equal(r3.action, 'alert', 'past cooldown → alert allowed again');
  });
});

// ============================================================================
// F4 — ageAlertMs
// ============================================================================

describe('F4 — ageAlertMs branch', () => {
  it('alerts on age even when idle is low', () => {
    const now = 400_000;
    const state = { lastEventAt: now - 5_000, startedAt: 0, _hasFirstRealEvent: true, _lastAlertTs: null };
    const r = pollSupervisor(state, now);
    assert.equal(r.action, 'alert');
    assert.match(r.reason, /^age:\d+s$/);
  });

  it('age alert is also subject to cooldown', () => {
    const now = 400_000;
    const state = { lastEventAt: now - 5_000, startedAt: 0, _hasFirstRealEvent: true, _lastAlertTs: now - 30_000 };
    const r = pollSupervisor(state, now);
    assert.equal(r.action, 'ok');
  });
});

// ============================================================================
// F5 — opts overrides
// ============================================================================

describe('F5 — opts overrides', () => {
  it('lowering silenceAlertMs fires alerts earlier', () => {
    const state = { lastEventAt: 0, startedAt: 0, _hasFirstRealEvent: true, _lastAlertTs: null };
    const r = pollSupervisor(state, 50_000, { silenceAlertMs: 30_000 });
    assert.equal(r.action, 'alert');
  });
});

// ============================================================================
// F6 — DEFAULTS sanity (guard against accidental regressions)
// ============================================================================

describe('F6 — DEFAULTS sanity', () => {
  it('alert thresholds are strictly less than trip thresholds', () => {
    assert.ok(DEFAULTS.silenceAlertMs < DEFAULTS.silenceTripMs);
    assert.ok(DEFAULTS.firstEventSilenceAlertMs < DEFAULTS.firstEventSilenceTripMs);
  });

  it('alertCooldownMs is at most silenceAlertMs (cooldown fits inside an alert cycle)', () => {
    assert.ok(DEFAULTS.alertCooldownMs <= DEFAULTS.silenceAlertMs);
  });
});
