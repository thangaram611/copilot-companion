#!/usr/bin/env node
// copilot-bridge MCP server (v6.1 — clean-break subagent-isolated architecture)
//
// Single MCP tool: `copilot` with actions send | wait | status | reply | cancel.
// No start/stop/pause/session-gate — this server is spawned inline per invocation
// from the copilot-companion subagent's frontmatter, so there is no separate
// activation lifecycle. Model selection and rubber-duck critique are internal
// server concerns and never exposed through the public schema.
//
// `send` blocks up to `max_wait_sec` (default 480) then returns either a
// terminal response or `status=still_running` with the job_id; the subagent
// loops on `wait` until terminal, emitting a short line between iterations to
// reset Claude Code's 600s stream-idle watchdog.
//
// Completion surfacing: each terminal/alert event is appended to a JSONL queue
// file with `consumed:false`; the drain script (invoked from the subagent's
// frontmatter hooks) filters out `consumed:true` and injects unconsumed orphans
// into the subagent's context. Wait-terminal responses mark the job's entries
// consumed so the subagent never sees the same event twice.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  appendFileSync, readFileSync, writeFileSync,
  renameSync, existsSync, realpathSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sendToSocket, ensureDaemon } from './daemon-client.mjs';
import {
  log,
  formatPrompt,
  appendRubberDuckReview,
  validateCopilotArgs,
} from './validation.mjs';
import {
  readDefaultModel,
  isModelAllowed,
  readThreadSid, writeThreadSid, listThreads,
  DEFAULT_MODEL,
} from '../lib/state.mjs';
import { createReqId, withReq, logEvent } from '../lib/log.mjs';

// --- Queue (replaces dev-channel notifications) -----------------------------

const QUEUE_PATH = process.env.COPILOT_QUEUE_PATH || '/tmp/copilot-completions.jsonl';

function enqueueEvent(event) {
  // Synchronous append; writes are small (~1-5KB). `consumed:false` lets the
  // drain script filter out events already surfaced by a wait-terminal MCP
  // response — the subagent never sees the same event twice.
  try {
    appendFileSync(
      QUEUE_PATH,
      JSON.stringify({ ts: Date.now(), consumed: false, ...event }) + '\n',
      { encoding: 'utf8' },
    );
  } catch (err) {
    log('WARN', 'enqueue failed:', err.message);
  }
}

function markQueueConsumed(jobId) {
  try {
    if (!existsSync(QUEUE_PATH)) return;
    const lines = readFileSync(QUEUE_PATH, 'utf8').split('\n').filter(Boolean);
    let changed = false;
    const updated = lines.map((line) => {
      try {
        const e = JSON.parse(line);
        if (e.jobId === jobId && !e.consumed) { e.consumed = true; changed = true; }
        return JSON.stringify(e);
      } catch { return line; }
    });
    if (!changed) return;
    const tmp = `${QUEUE_PATH}.consume.${process.pid}`;
    writeFileSync(tmp, updated.join('\n') + '\n');
    renameSync(tmp, QUEUE_PATH);
  } catch (err) {
    log('WARN', 'markQueueConsumed failed:', err.message);
  }
}

log('INFO', 'bridge start:', `pid=${process.pid} ppid=${process.ppid}`);

// --- Job tracking -----------------------------------------------------------

const jobs = new Map();
const JOB_RETENTION_MS = 60 * 60 * 1000;
const JOB_GC_INTERVAL_MS = 60 * 1000;

const jobsGcTimer = setInterval(() => gcExpiredJobs(), JOB_GC_INTERVAL_MS);
if (jobsGcTimer.unref) jobsGcTimer.unref();

function gcExpiredJobs(now = Date.now()) {
  for (const [jobId, job] of jobs) {
    if (!job.terminalAt || !job.retentionExpiresAt) continue;
    if (job.retentionExpiresAt > now) continue;
    jobs.delete(jobId);
    log('INFO', 'gc job:', jobId, `status=${job.status}`);
  }
}

function getJob(jobId) { gcExpiredJobs(); return jobs.get(jobId) || null; }
function updateJob(jobId, patch) { const j = jobs.get(jobId); if (j) Object.assign(j, patch); return j || null; }
function retainTerminalJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const terminalAt = patch.terminalAt || Date.now();
  Object.assign(job, patch, {
    terminalAt,
    retentionExpiresAt: terminalAt + JOB_RETENTION_MS,
    inspectAvailable: Boolean(job.promptId || patch.promptId),
  });
  resolveAllWaiters(jobId, { terminal: true, job });
  return job;
}

function iso(ts) { return ts ? new Date(ts).toISOString() : null; }
function normalizeInspectLimit(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return 40;
  return Math.max(1, Math.min(n, 200));
}

async function fetchPromptInspect(job, { includeTimeline = false, limit = 40 } = {}) {
  if (!job?.promptId) return null;
  const resp = await sendToSocket(
    { command: 'inspect', promptId: job.promptId, includeTimeline, limit: normalizeInspectLimit(limit) },
    15_000,
  );
  if (!resp.ok) throw new Error(`inspect failed: ${resp.error}`);
  return resp.data;
}

function buildJobResponse(job, inspect = null, { includeTimeline = false } = {}) {
  const data = inspect || {};
  return {
    ok: true,
    job_id: job.jobId,
    status: data.status || job.status || 'unknown',
    prompt_id: data.promptId || job.promptId || null,
    session_id: data.sessionId || job.sessionId || null,
    mode: job.mode || null,
    thread: job.thread || null,
    cwd: data.cwd || job.cwd || null,
    started_at: data.startedAt || iso(job.startedAt),
    terminal_at: data.terminalAt || iso(job.terminalAt),
    ms_since_last_event:
      data.msSinceLastEvent ??
      (job.terminalAt ? 0 : Math.max(0, Date.now() - (job.startedAt || Date.now()))),
    stuck_reason: data.stuckReason || job.stuckReason || null,
    supervisor_detail: data.stuckDetail || job.stuckDetail || null,
    failed_tools: Array.isArray(data.failedTools) && data.failedTools.length > 0
      ? data.failedTools : Array.isArray(job.failedTools) ? job.failedTools : [],
    latest_plan: data.latestPlan || null,
    inspect_available: Boolean(
      data.inspectAvailable ?? job.inspectAvailable ??
      (job.promptId && (!job.retentionExpiresAt || job.retentionExpiresAt > Date.now()))
    ),
    retention_expires_at: data.retentionExpiresAt || iso(job.retentionExpiresAt),
    activity:           includeTimeline ? (Array.isArray(data.activity) ? data.activity : []) : undefined,
    activity_count:     includeTimeline ? (data.activityCount ?? 0) : undefined,
    activity_truncated: includeTimeline ? Boolean(data.activityTruncated) : undefined,
  };
}

// --- Waiters (v6.1) --------------------------------------------------------
//
// Each blocking action (send, wait) parks a resolver on the target jobId. The
// worker calls resolveAllWaiters through retainTerminalJob when the job
// reaches a terminal state. A per-call timeout returns {timeout:true, job} so
// the subagent can loop with a fresh wait.

const waiters = new Map(); // jobId -> Set<resolver>

function parkWaiter(jobId, resolver) {
  if (!waiters.has(jobId)) waiters.set(jobId, new Set());
  waiters.get(jobId).add(resolver);
}
function unparkWaiter(jobId, resolver) {
  const set = waiters.get(jobId);
  if (!set) return;
  set.delete(resolver);
  if (set.size === 0) waiters.delete(jobId);
}
function resolveAllWaiters(jobId, value) {
  const set = waiters.get(jobId);
  if (!set) return;
  waiters.delete(jobId);
  for (const r of set) { try { r(value); } catch {} }
}

function waitForJob(jobId, maxWaitSec) {
  return new Promise((resolve) => {
    const existing = getJob(jobId);
    if (!existing) { resolve({ unknown: true }); return; }
    if (existing.terminalAt) { resolve({ terminal: true, job: existing }); return; }
    let settled = false;
    const resolver = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unparkWaiter(jobId, resolver);
      resolve(value);
    };
    parkWaiter(jobId, resolver);
    const timer = setTimeout(
      () => resolver({ timeout: true, job: getJob(jobId) }),
      Math.max(1, maxWaitSec) * 1000,
    );
  });
}

function buildWaitResponse(outcome) {
  if (outcome.unknown) {
    return asJson({
      ok: false, action: 'wait', status: 'unknown_job',
      error: "unknown job_id (may have been GC'd after retention expired)",
    });
  }
  const job = outcome.job;
  if (outcome.timeout) {
    return asJson({
      ok: true, action: 'wait', status: 'still_running',
      job_id: job.jobId,
      // Surface thread even on still_running so a crash+resume can still
      // recover it. (v6.1 thread-continuity invariant.)
      thread: job.thread || null,
      current_status: job.status || 'running',
      started_at: iso(job.startedAt),
      age_s: Math.round((Date.now() - (job.startedAt || Date.now())) / 1000),
      hint: 'call copilot({action:"wait", job_id, max_wait_sec}) again to continue blocking.',
    });
  }
  markQueueConsumed(job.jobId);
  return asJson({
    ok: true, action: 'wait', status: job.status,
    job_id: job.jobId,
    duration_ms: job.durationMs || null,
    content: formatTerminalContent(job),
    meta: {
      job_id: job.jobId, status: job.status,
      mode: job.mode || 'EXECUTE',
      thread: job.thread || null,
      prompt_id: job.promptId || null,
      session_id: job.sessionId || null,
      failed_tools: Array.isArray(job.failedTools) ? job.failedTools.join(',') : '',
      stuck_reason: job.stuckReason || null,
    },
  });
}

// --- Notification payload ---------------------------------------------------

function emitAlertNotification({ jobId, task, promptId, alert, startedAt, reqId = null }) {
  const ageSec = Math.round((Date.now() - startedAt) / 1000);
  const content = [
    `Task: ${truncate(task, 200)}`,
    '',
    `**promptId:** ${promptId}  |  **age:** ${ageSec}s  |  **tier:** ${alert.tier}  |  **reason:** ${alert.reason}`,
  ].join('\n');
  const meta = {
    job_id: jobId, status: 'watchdog', prompt_id: promptId,
    age_sec: String(ageSec), tier: String(alert.tier), reason: alert.reason,
  };
  if (reqId) meta.req_id = String(reqId);
  enqueueEvent({ kind: 'alert', jobId, content, meta });
}

// Pure formatter: takes the fields a terminal job carries and returns the
// human-readable body. Extracted from emitNotification so buildWaitResponse
// can reuse the exact same formatting when the subagent blocks to completion.
function formatTerminalContent({
  jobId, status, task, mode, durationMs,
  summary, error, stuckReason, failedTools, promptId,
}) {
  const taskHeader = `Task: ${truncate(task, 200)}\n\n`;
  const duration = durationMs || 0;
  const rubberDuck = classifyRubberDuck(summary?.message);

  if (status === 'completed' && summary?.message) {
    const filesTouched = (summary.toolCalls || [])
      .map((tc) => tc?.input?.path || tc?.input?.file_path)
      .filter(Boolean);
    const filesLine = filesTouched.length
      ? `\n\n**Files touched:** ${[...new Set(filesTouched)].slice(0, 10).join(', ')}`
      : '';
    const failedLine = (Array.isArray(failedTools) && failedTools.length)
      ? `\n\n**Failed tools:** ${failedTools.slice(0, 10).join(', ')}`
      : '';
    let rubberDuckFooter = '';
    if (rubberDuck === 'clean') {
      rubberDuckFooter = '\n\n_Rubber-duck: ✓ clean_';
    } else if (rubberDuck === 'revised') {
      rubberDuckFooter = '\n\n_Rubber-duck: ↻ revised — see `RUBBER-DUCK:` in the message above._';
    }
    return taskHeader + summary.message +
      `\n\n**Tool calls:** ${(summary.toolCalls || []).length}  •  **Duration:** ${Math.round(duration / 1000)}s` +
      filesLine + failedLine + rubberDuckFooter;
  }
  if (status === 'stuck') {
    return taskHeader +
      `Copilot got stuck on: \`${stuckReason || 'unknown'}\`.\n\n` +
      (promptId
        ? `Inspect with \`copilot({action:"status", job_id:"${jobId}", verbose:true})\` before deciding whether to recover directly.`
        : 'Prompt inspection is unavailable for this job; decide whether to re-fire or recover directly.');
  }
  if (status === 'failed') {
    return taskHeader + `Copilot job failed: ${error || 'unknown error'}`;
  }
  if (status === 'cancelled') {
    return taskHeader + 'Copilot job was cancelled.' +
      (summary?.message ? `\n\nPartial output:\n${summary.message}` : '');
  }
  if (status === 'running') {
    return taskHeader + "Copilot job exceeded the bridge's wait budget. Daemon was asked to cancel.";
  }
  return taskHeader + `Unexpected terminal status: ${status}`;
}

function emitNotification({
  jobId, status, summary, error, stuckReason, duration,
  task, mode, cwd, thread = null, promptId = null, sessionId = null,
  reconciled = false, bridgeReason = null, failedTools = [], reqId = null,
}) {
  if (
    status === 'completed' &&
    typeof summary?.message === 'string' &&
    /(?:^|\n)\s*(?:Info:\s*)?Operation cancelled by user\.?\s*$/i.test(summary.message.trim())
  ) {
    status = 'stuck';
    if (!stuckReason) stuckReason = 'cancelled_before_summary';
  }

  const meta = {
    job_id: jobId, status,
    duration_ms: String(duration),
    mode: mode || 'EXECUTE',
  };
  if (cwd)       meta.cwd = String(cwd);
  if (thread)    meta.thread = String(thread);
  if (promptId)  meta.prompt_id = String(promptId);
  if (sessionId) meta.session_id = String(sessionId);
  meta.inspect_available = promptId ? 'true' : 'false';
  if (summary?.toolCalls)  meta.tool_calls  = String(summary.toolCalls.length || 0);
  if (summary?.stopReason) meta.stop_reason = String(summary.stopReason);
  if (stuckReason)         meta.stuck_reason = String(stuckReason).slice(0, 80);
  if (Array.isArray(failedTools) && failedTools.length) meta.failed_tools = failedTools.join(',').slice(0, 80);
  if (reconciled)   meta.reconciled = 'true';
  if (bridgeReason) meta.bridge_reason = String(bridgeReason).slice(0, 40);
  if (reqId)        meta.req_id = String(reqId);

  const rubberDuck = classifyRubberDuck(summary?.message);
  if (status === 'completed') meta.rubber_duck = rubberDuck;

  const content = formatTerminalContent({
    jobId, status, task, mode, durationMs: duration,
    summary, error, stuckReason, failedTools, promptId,
  });

  enqueueEvent({ kind: 'terminal', jobId, content, meta });
  if (status === 'completed' && rubberDuck === 'missing') {
    log('WARN', 'emit:', jobId, 'rubber_duck verdict missing from completed message — Copilot output drifted from wrapper contract');
  }
  log('INFO', 'emit:', jobId, `status=${status} duration_ms=${duration}${status === 'completed' ? ` rubber_duck=${rubberDuck}` : ''}${stuckReason ? ` stuck=${stuckReason}` : ''}${bridgeReason ? ` bridge=${bridgeReason}` : ''}`);
}

function truncate(s, n) { if (!s) return ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Classify the rubber-duck verdict surfaced by Copilot in the final message.
// The rubber-duck wrapper is always appended to the prompt, so every completed
// job should yield exactly one `RUBBER-DUCK: clean.` or `RUBBER-DUCK: revised …`
// line. A 'missing' verdict means Copilot's output drifted from the wrapper's
// contract — logged at WARN for visibility.
export function classifyRubberDuck(message) {
  if (!message) return 'missing';
  const m = String(message).match(/(?:^|\n)\s*RUBBER-DUCK:\s*(clean|revised)\b/i);
  if (!m) return 'missing';
  return m[1].toLowerCase();
}

// --- Worker -----------------------------------------------------------------

const MAX_JOB_MS = 30 * 60 * 1000;

async function runWorker({ jobId, reqId, task, mode, template, template_args, cwd, thread, model, previousSid }) {
  const startedAt = Date.now();
  let sessionId = null;
  const rlog = withReq(reqId, { job_id: jobId });
  rlog.info('worker.start', { mode, template, thread: thread || null, model, cwd: cwd || null });
  log('INFO', 'worker start:', jobId, `req=${reqId} mode=${mode} template=${template} thread=${thread || '-'} model=${model} cwd=${cwd || '(default)'}`);
  try {
    await ensureDaemon({ reqId });

    let formatted = formatPrompt({ template, task, mode, template_args });
    // plan_review prompts already embed their own senior-architect critique
    // instructions; layering the generic rubber-duck wrapper on top doubles
    // the prompt size without changing the output. Skip it for that template
    // only — every other template still gets the always-on wrapper.
    if (template !== 'plan_review') {
      formatted = appendRubberDuckReview(formatted);
    }

    const startResp = await sendToSocket({
      command: 'prompt-bg',
      sessionId: previousSid || null,
      text: formatted,
      cwd: cwd || undefined,
      model,
      reqId,
    });
    if (!startResp.ok) throw new Error(`prompt-bg failed: ${startResp.error}`);
    const { promptId, sessionId: sid } = startResp.data;
    sessionId = sid;
    rlog.info('worker.prompt_started', { prompt_id: promptId, session_id: sessionId });
    log('INFO', 'worker prompt started:', jobId, `promptId=${promptId} sessionId=${sessionId}`);

    updateJob(jobId, { promptId, sessionId, status: 'running', inspectAvailable: true });

    if (thread && sessionId) {
      try { writeThreadSid(thread, sessionId); }
      catch (err) { log('WARN', 'writeThreadSid failed:', err.message); }
    }

    let result;
    while (true) {
      result = await awaitTerminal(promptId, 480);
      if (result?.interim) {
        emitAlertNotification({ jobId, task, promptId, alert: result.alert, startedAt, reqId });
        if (Date.now() - startedAt > MAX_JOB_MS) throw new Error(`watch loop exceeded MAX_JOB_MS (${MAX_JOB_MS}ms)`);
        continue;
      }
      break;
    }

    if (result.status === 'failed' && result.error === 'prompt timeout') {
      result.status = 'stuck';
      result.stuckReason = 'prompt_timeout';
      result.error = null;
      rlog.warn('worker.remap_prompt_timeout', { prompt_id: promptId });
      log('INFO', 'remap prompt_timeout:', jobId, `promptId=${promptId} → status=stuck`);
    }

    const duration = Date.now() - startedAt;
    const failedTools = failedToolsFromJsonl(promptId);
    retainTerminalJob(jobId, {
      promptId, sessionId,
      status: result.status, summary: result.summary,
      error: result.error, stuckReason: result.stuckReason,
      failedTools, durationMs: duration,
      terminalAt: Date.now(),
    });
    rlog.info('worker.terminal', { status: result.status, duration_ms: duration, failed_tools: failedTools?.length || 0 });
    emitNotification({
      jobId,
      status: result.status, summary: result.summary,
      error: result.error, stuckReason: result.stuckReason,
      duration, task, mode, cwd, thread,
      promptId, sessionId, failedTools, reqId,
    });
  } catch (err) {
    const duration = Date.now() - startedAt;
    const promptId = jobs.get(jobId)?.promptId;
    const currentSessionId = jobs.get(jobId)?.sessionId || sessionId;
    const isReconcilableErr = !!promptId && (
      (err && typeof err.code === 'string' && ['ECONNREFUSED', 'ENOENT', 'EPIPE', 'ETIMEDOUT'].includes(err.code)) ||
      /timeout/i.test(err?.message || '')
    );
    const reconciled = isReconcilableErr ? await reconcileAfterTimeout(promptId) : null;
    rlog.warn('worker.catch', { error: err.message, reconciled: reconciled?.status || null });
    log('WARN', 'worker catch:', jobId, `err="${err.message}" reconciled=${reconciled?.status || 'n/a'}`);
    retainTerminalJob(jobId, {
      promptId: promptId || null,
      sessionId: currentSessionId || null,
      status: reconciled?.status ?? 'failed',
      summary: reconciled?.summary ?? null,
      error: reconciled?.error ?? err.message,
      stuckReason: reconciled?.stuckReason ?? null,
      failedTools: promptId ? failedToolsFromJsonl(promptId) : [],
      durationMs: duration, terminalAt: Date.now(),
    });
    emitNotification({
      jobId,
      status: reconciled?.status ?? 'failed',
      summary: reconciled?.summary ?? null,
      error: reconciled?.error ?? err.message,
      stuckReason: reconciled?.stuckReason ?? null,
      duration, task, mode, cwd, thread,
      promptId: promptId || null,
      sessionId: currentSessionId || null,
      failedTools: promptId ? failedToolsFromJsonl(promptId) : [],
      bridgeReason: reconciled?.bridgeReason || null,
      reconciled: !!reconciled,
      reqId,
    });
  } finally {
    rlog.info('worker.end', { duration_ms: Date.now() - startedAt });
    log('INFO', 'worker end:', jobId, `duration_ms=${Date.now() - startedAt}`);
  }
}

async function awaitTerminal(promptId, maxWaitSec) {
  const timeoutMs = Math.min((maxWaitSec + 120) * 1000, 10 * 60 * 1000);
  const resp = await sendToSocket(
    { command: 'watch', promptId, since: 0, raw: false, wait: maxWaitSec, summaryOnly: true },
    timeoutMs,
  );
  if (!resp.ok) throw new Error(`await failed: ${resp.error}`);
  return resp.data;
}

async function reconcileAfterTimeout(promptId) {
  try {
    const resp = await sendToSocket(
      { command: 'watch', promptId, since: 0, raw: false, wait: 0, summaryOnly: true },
      5_000,
    );
    const data = resp?.ok ? resp.data : null;
    if (data?.status === 'completed') {
      return { status: 'completed', summary: data.summary, error: null, stuckReason: null, bridgeReason: 'reconciled_completed' };
    }
    if (data?.status === 'stuck' || data?.status === 'cancelled') {
      return { status: 'stuck', summary: null, error: null, stuckReason: data.stuckReason || data.status, bridgeReason: 'reconciled_stuck' };
    }
    return { status: 'stuck', summary: null, error: null, stuckReason: 'bridge_timeout', bridgeReason: 'bridge_timeout' };
  } catch {
    return { status: 'stuck', summary: null, error: null, stuckReason: 'bridge_daemon_unreachable', bridgeReason: 'bridge_daemon_unreachable' };
  }
}

function failedToolsFromJsonl(promptId) {
  try {
    const content = readFileSync(`/tmp/copilot-acp-${promptId}.jsonl`, 'utf8');
    const byId = new Map();
    const names = new Set();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'tool_call') byId.set(ev.toolCallId, ev.name);
      else if (ev.type === 'tool_call_update' && ev.status === 'failed') {
        const name = ev.name || byId.get(ev.toolCallId);
        if (name) names.add(name);
      }
    }
    return [...names];
  } catch { return []; }
}

// --- Action handlers --------------------------------------------------------

function asJson(obj) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }

async function handleSend(args) {
  // v6.1: bridge auto-generates a thread name if caller (the companion
  // subagent) did not pass one. This is how the companion gets a stable
  // handle it can remember across resumes — main never sees or carries it.
  // Pre-compute the jobId first so we can derive thread = companion-<jobId>.
  const jobId = `copilot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const thread = args.thread || `companion-${jobId}`;

  // Thread → previous Copilot sid. If the caller passed an explicit thread
  // name that doesn't exist yet, readThreadSid returns null (new thread).
  // An auto-generated companion-<jobId> is brand new too, so null.
  let previousSid = null;
  try { previousSid = readThreadSid(thread); }
  catch (err) { return asJson({ ok: false, error: err.message }); }

  const { model } = readDefaultModel();
  if (!isModelAllowed(model)) {
    return asJson({
      ok: false, reason: 'model-not-allowed', model,
      hint: 'configure default_model to an allowed id',
    });
  }

  const reqId = createReqId();
  jobs.set(jobId, {
    jobId, reqId,
    task: args.task, mode: args.mode,
    template: args.template, cwd: args.cwd,
    thread,
    startedAt: Date.now(),
    status: 'starting', inspectAvailable: false,
  });
  logEvent('info', 'copilot.send', {
    req_id: reqId, job_id: jobId,
    template: args.template, mode: args.mode,
    thread, model,
  });
  log('INFO', 'copilot:send', `job=${jobId} req=${reqId} template=${args.template} mode=${args.mode} thread=${thread} model=${model}`);

  runWorker({
    jobId, reqId,
    task: args.task, mode: args.mode,
    template: args.template, template_args: args.template_args,
    cwd: args.cwd, thread, model, previousSid,
  }).catch((err) => log('ERROR', 'worker error:', err.message));

  const maxWaitSec = Math.max(1, Math.min(Number(args.max_wait_sec) || 480, 540));
  const outcome = await waitForJob(jobId, maxWaitSec);
  return buildWaitResponse(outcome);
}

async function handleWait({ job_id, max_wait_sec }) {
  if (!job_id) return asJson({ ok: false, action: 'wait', error: 'job_id required' });
  const max = Math.max(1, Math.min(Number(max_wait_sec) || 480, 540));
  const outcome = await waitForJob(job_id, max);
  return buildWaitResponse(outcome);
}

async function handleCancel({ job_id }) {
  if (!job_id) return asJson({ ok: false, action: 'cancel', error: 'job_id required' });
  const job = getJob(job_id);
  if (!job)                                       return asJson({ ok: false, error: 'unknown job_id' });
  if (!job.promptId || job.status === 'starting') return asJson({ ok: false, error: 'job is not yet cancellable' });
  if (job.status !== 'running')                   return asJson({ ok: false, error: `job is ${job.status}` });
  const resp = await sendToSocket({ command: 'cancel', promptId: job.promptId });
  // v6.1 gap fix: cancel also surfaces the job via the cancel MCP response,
  // so mark the queue entry consumed to avoid a duplicate drain injection.
  if (resp.data?.cancelled) markQueueConsumed(job_id);
  return asJson({
    ok: true, action: 'cancel', job_id,
    cancelled: !!resp.data?.cancelled, reason: resp.data?.reason,
  });
}

async function handleReply({ job_id, message }) {
  // Re-steer an in-flight job. Triple guard: validation rejects missing
  // message; this handler rejects unknown/terminal jobs locally (cheap fast
  // path); the daemon enforces its own per-prompt lock so two concurrent
  // replies cannot race the cancel-and-restart sequence.
  const job = getJob(job_id);
  if (!job) return asJson({ ok: false, action: 'reply', error: 'unknown job_id' });
  if (!job.promptId) return asJson({ ok: false, action: 'reply', error: 'job has no prompt yet — wait for status: running' });
  if (job.terminalAt) return asJson({ ok: false, action: 'reply', error: `job is already ${job.status} — start a new send` });
  if (job.replyInFlight) return asJson({ ok: false, action: 'reply', error: 'reply already in flight for this job' });

  job.replyInFlight = true;
  try {
    const resp = await sendToSocket({ command: 'reply', promptId: job.promptId, message }, 15_000);
    if (!resp.ok || !resp.data?.ok) {
      const reason = resp.data?.reason || resp.error || 'reply failed';
      return asJson({ ok: false, action: 'reply', job_id, error: reason });
    }
    log('INFO', 'copilot:reply', `job=${job_id} new_prompt=${resp.data.new_prompt_id}`);
    return asJson({
      ok: true, action: 'reply', job_id,
      original_prompt_id: resp.data.original_prompt_id,
      new_prompt_id: resp.data.new_prompt_id,
      session_id: resp.data.session_id,
      hint: 'reply accepted. The original turn was cancelled; the follow-up runs as a new prompt on the same Copilot session.',
    });
  } finally {
    job.replyInFlight = false;
  }
}

async function handleStatus({ job_id, verbose }) {
  if (job_id) {
    const job = getJob(job_id);
    if (!job) return asJson({ ok: false, error: 'unknown job_id' });
    let inspect = null;
    if (job.promptId) {
      try { inspect = await fetchPromptInspect(job, { includeTimeline: verbose }); }
      catch (err) { log('WARN', 'status inspect failed:', job_id, err.message); }
    }
    return asJson(buildJobResponse(job, inspect, { includeTimeline: verbose }));
  }
  const modelInfo = readDefaultModel();
  return asJson({
    ok: true, action: 'status',
    default_model: modelInfo,
    threads: listThreads(),
    jobs_in_memory: jobs.size,
    running_jobs: [...jobs.values()]
      .filter((j) => !j.terminalAt)
      .map((j) => ({
        job_id: j.jobId,
        status: j.status || 'starting',
        mode: j.mode || null,
        thread: j.thread || null,
        prompt_id: j.promptId || null,
        started_at: iso(j.startedAt),
        age_s: Math.round((Date.now() - (j.startedAt || Date.now())) / 1000),
        reply_in_flight: !!j.replyInFlight,
      })),
  });
}

// --- MCP server setup -------------------------------------------------------

const mcp = new Server(
  { name: 'copilot-bridge', version: '0.0.1' },
  {
    capabilities: { tools: {} },
    instructions:
      'Internal MCP server for the copilot-companion subagent. Spawned inline ' +
      'per invocation via the subagent\'s `mcpServers` frontmatter (the standalone ' +
      'agent at ~/.claude/agents/copilot-companion.md, materialized by the ' +
      'plugin\'s install-agent.sh SessionStart hook). Not registered at session ' +
      'scope — main Claude does not see this tool surface. Actions: send ' +
      '(blocking), wait, status, reply, cancel. The companion uses send for ' +
      'kickoff then loops on wait until terminal. Completion events are also ' +
      'appended to /tmp/copilot-completions.jsonl for the plugin\'s drain hooks.',
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'copilot',
      description:
        'Internal Copilot companion tool. Actions: send | wait | status | reply | cancel. ' +
        'Not exposed to main Claude — only the copilot-companion subagent invokes this. ' +
        'Rubber-duck critique and model selection are handled server-side.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['send', 'wait', 'status', 'reply', 'cancel'],
            description:
              'send: delegate a task, BLOCK up to max_wait_sec seconds, return terminal OR still_running with job_id. ' +
              'wait: block on an existing job_id up to max_wait_sec seconds. ' +
              'status: without job_id returns global state; with job_id returns job diagnostics. ' +
              'reply: re-steer an in-flight job (requires job_id + message). ' +
              'cancel: cancel a specific running job (requires job_id).',
          },
          task: {
            type: 'string',
            description: '[send] Plain-language description of the task.',
          },
          message: {
            type: 'string',
            description:
              '[reply] Follow-up text to inject into a running job. The current ' +
              'in-flight turn is cancelled and a new turn is started on the same ' +
              'Copilot session with this message wrapped as a continuation.',
          },
          mode: {
            type: 'string',
            enum: ['PLAN', 'ANALYZE', 'EXECUTE'],
            description:
              '[send] PLAN: produce a plan, read-only. ANALYZE: investigate, read-only. ' +
              'EXECUTE (default): Copilot may edit/write/shell.',
          },
          template: {
            type: 'string',
            enum: ['general', 'research', 'plan_review'],
            description:
              '[send] Prompt template. Defaults to "general". "research" for evidence-backed web research. ' +
              '"plan_review" for senior-architect plan reviews (requires template_args.plan_path).',
          },
          template_args: {
            type: 'object',
            description: '[send] Template-specific arguments. Only plan_review consumes these.',
            additionalProperties: false,
            properties: {
              plan_path:       { type: 'string', description: 'Absolute path to the plan .md (or "latest").' },
              focus_directive: { type: 'string', description: 'Optional focus directive for plan_review.' },
            },
          },
          cwd: {
            type: 'string',
            description: '[send] Absolute working directory for Copilot. Useful for parallel isolated worktrees.',
          },
          thread: {
            type: 'string',
            description:
              '[send] Optional thread name. If omitted the bridge auto-generates `companion-<jobId>`. ' +
              'Supplying a remembered thread name resumes a prior Copilot session for multi-turn continuity.',
            pattern: '^[a-zA-Z0-9._-]+$',
          },
          max_wait_sec: {
            type: 'number',
            description:
              '[send|wait] Upper bound on how long the bridge blocks this call before returning ' +
              'still_running. Default 480, max 540 (leaves headroom under the MCP 600s stream-idle cap).',
          },
          job_id:  { type: 'string',  description: '[wait|status|reply|cancel] Target a specific job.' },
          verbose: { type: 'boolean', description: '[status] Include full activity timeline when a job_id is given.' },
        },
        required: ['action'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'copilot') throw new Error(`unknown tool: ${req.params.name}`);
  const normalized = validateCopilotArgs(req.params.arguments || {});
  return dispatch(normalized);
});

// Exported dispatcher lets tests drive the action handlers directly without
// going through MCP transport plumbing.
export async function dispatch(normalized) {
  switch (normalized.action) {
    case 'send':   return handleSend(normalized);
    case 'wait':   return handleWait(normalized);
    case 'status': return handleStatus(normalized);
    case 'reply':  return handleReply(normalized);
    case 'cancel': return handleCancel(normalized);
    default: throw new Error(`copilot: unhandled action "${normalized.action}"`);
  }
}

export { mcp, jobs };

// Only attach stdio transport when launched as a script. Allows
// `import('./server.mjs')` from tests without spawning a real MCP loop.
// Resolve both sides through realpath so a symlinked argv[1] still matches
// import.meta.url.
const isMain = (() => {
  try {
    const argvReal = realpathSync(process.argv[1]);
    const metaReal = realpathSync(fileURLToPath(import.meta.url));
    return argvReal === metaReal;
  } catch { return false; }
})();
if (isMain) {
  await mcp.connect(new StdioServerTransport());
}
