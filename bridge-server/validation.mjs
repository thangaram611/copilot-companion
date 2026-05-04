// Pure-function helpers for the copilot-bridge MCP server (v6.1).
//
// One public tool (`copilot`) with five actions: send | wait | status | reply | cancel.
// Validation is split per-action; the dispatch happens in the server. Error
// messages are prefixed with `copilot:` so MCP clients can surface them as
// synchronous tool-call rejections.
//
// Nothing in here opens sockets, spawns processes, or reads state files —
// it's safe to import from tests without side effects other than appending
// a line to <runtime-dir>/bridge.log on the `log()` helper.

import {
  readdirSync,
  statSync,
  realpathSync,
  appendFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { isAbsolute, join, sep as pathSep } from 'node:path';
import { homedir } from 'node:os';

import { bridgeLogPath, ensureRuntimeDir, SECURE_FILE_MODE } from '../lib/paths.mjs';

// --- Logger -----------------------------------------------------------------
//
// Lives inside the per-user 0o700 runtime dir (see lib/paths.mjs). Previously
// at /tmp/copilot-bridge.log — world-readable, contradicted the security
// claim of the runtime-dir migration.

export const BRIDGE_LOG_MAX_BYTES = 1024 * 1024;

// One-shot tracking of an ensureRuntimeDir() failure so we don't spam
// stderr on every WARN/ERROR/FATAL line after the dir verification has
// already been rejected once. Logging recovery requires a process restart
// once tripped — fine for the bridge since it's a per-invocation process.
let _logSecuritySurfaced = false;

export function log(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${ts} [${level}] ${msg}\n`;

  // Critical: a security failure here (dir owned by attacker, wrong mode,
  // symlink planted) MUST NOT be silently swallowed — that would let an
  // attacker who can fail the invariants prevent ALL bridge logging
  // without leaving a trail. Surface to stderr once and disable further
  // file logging for this process. I/O failures (disk full, etc.) stay
  // best-effort below.
  let dirOk = true;
  try {
    ensureRuntimeDir();
  } catch (err) {
    dirOk = false;
    if (!_logSecuritySurfaced) {
      _logSecuritySurfaced = true;
      try {
        process.stderr.write(
          `[copilot-bridge] ensureRuntimeDir failed; bridge log disabled: ${err.message}\n`
        );
      } catch {}
    }
  }

  if (dirOk) {
    try {
      const bridgeLog = bridgeLogPath();
      if (existsSync(bridgeLog) && statSync(bridgeLog).size > BRIDGE_LOG_MAX_BYTES) {
        // v6.1 C4: keep the previous log in .bak instead of truncating in
        // place. Truncate-on-rotate dropped the most recent diagnostic data
        // exactly when something went wrong enough to fill the log.
        try { renameSync(bridgeLog, bridgeLog + '.bak'); }
        catch { writeFileSync(bridgeLog, '', { mode: SECURE_FILE_MODE }); }
      }
      appendFileSync(bridgeLog, line, { mode: SECURE_FILE_MODE });
    } catch { /* best-effort I/O — distinct from the security failure above */ }
  }

  // High-severity always also goes to stderr regardless of dir state, so
  // operators can see errors when the log file is unreachable.
  if (level === 'WARN' || level === 'ERROR' || level === 'FATAL') {
    try { process.stderr.write(line); } catch {}
  }
}

// --- Constants --------------------------------------------------------------

export const VALID_ACTIONS   = new Set(['send', 'wait', 'status', 'reply', 'cancel']);
export const VALID_MODES     = new Set(['PLAN', 'ANALYZE', 'EXECUTE']);
export const VALID_TEMPLATES = new Set(['general', 'research', 'plan_review']);
export const DEFAULT_MODE    = 'EXECUTE';

// Field surface per action. Anything outside these is an "unknown key" error.
const ALLOWED_FIELDS = {
  send:   new Set(['action', 'task', 'mode', 'template', 'template_args', 'cwd', 'thread', 'max_wait_sec']),
  wait:   new Set(['action', 'job_id', 'max_wait_sec']),
  status: new Set(['action', 'job_id', 'verbose']),
  reply:  new Set(['action', 'job_id', 'message']),
  cancel: new Set(['action', 'job_id']),
};

const VALID_TEMPLATE_ARGS_KEYS = new Set(['plan_path', 'focus_directive']);

// --- Prompt templates -------------------------------------------------------

export function formatGeneralTemplate({ task, mode }) {
  const modeLine =
    mode === 'EXECUTE'
      ? 'You may use `edit`, `write`, `shell`, and the `task` tool. Be precise about file paths and the exact changes you intend.'
      : mode === 'PLAN'
        ? 'Do not modify any files — produce a plan only. Read-only tools (`view`, `grep`, `glob`, `web_search`, `web_fetch`, and read-only sub-agents) are fine. End the answer with a concrete, numbered implementation plan.'
        : 'Do not modify any files — no `edit`, `write`, or file-mutating `shell` commands. Read-only tools (`view`, `grep`, `glob`, `web_search`, `web_fetch`, and the `task` tool for read-only sub-agents) are fine.';
  const label = mode === 'EXECUTE' ? 'EXECUTE' : mode === 'PLAN' ? 'PLAN' : 'ANALYZE';
  return [
    `TASK: ${task}`,
    '',
    `Mode: ${label}`,
    modeLine,
    '',
    'Return: a concise answer plus the list of files you inspected or changed.',
  ].join('\n');
}

export function formatResearchTemplate({ task }) {
  return [
    'You are a research assistant. The user wants a focused, evidence-backed answer to:',
    '',
    `  ${task}`,
    '',
    'Use `web_search` and `web_fetch` as needed. Read at least 2-3 reputable sources before answering.',
    'Use only `web_search` and `web_fetch` — no shell, no file edits.',
    '',
    'Anti-hallucination rules (strict):',
    "- Only claim a fact, URL, file path, function, constant, or command exists if you JUST verified it in THIS turn via a tool call. Do not cross-reference prior conversation context or things you vaguely remember from training.",
    "- If the question asks about the user's own repo/files and you have not directly read them in this turn with a tool call, say so explicitly instead of inferring. Never describe the user's files from search-result bleed-through.",
    "- When quoting a source, prefer verbatim text inside backticks over paraphrase. If you can't quote, label the claim \"(inferred)\" so the reader knows.",
    '- If search results disagree or are thin, surface that disagreement — do not collapse it into a single confident answer.',
    '',
    'Return a structured response:',
    '1. Direct answer (1-3 sentences)',
    '2. Key findings (bullet points with concrete details)',
    '3. Caveats / dissenting views (if any)',
    '4. Sources (URLs you actually fetched, with one-line descriptions)',
    '',
    'Be concise. Skip filler.',
  ].join('\n');
}

export function formatPlanReviewTemplate({ template_args }) {
  const planPath = template_args?.plan_path;
  const focus = template_args?.focus_directive;
  if (!planPath) throw new Error('internal: plan_review reached formatter without plan_path');
  return [
    'You are a senior software architect reviewing an implementation plan produced by another AI coding',
    'assistant. The plan lives at:',
    '',
    `  ${planPath}`,
    '',
    'Read it with the `view` tool. Then use `view`, `grep`, and `glob` on the project codebase to verify',
    "that files, functions, APIs, and patterns referenced in the plan actually exist and match the plan's",
    'description.',
    '',
    'Review priorities (in order):',
    '1. Correctness — Will the changes solve the stated problem? Wrong assumptions or misunderstood APIs?',
    '2. Completeness — Missing steps, unhandled edge cases, files that need changes but are not listed?',
    '3. Safety — Could the changes break existing functionality or cause regressions?',
    '4. Consistency — Do the changes follow codebase patterns? Internal contradictions?',
    '5. Verification — Are there adequate type-check, lint, and test steps?',
    '',
    focus ? `[FOCUS DIRECTIVE: ${focus}]` : '',
    '',
    'DO NOT flag: style preferences, equivalent alternatives, theoretical concerns without evidence,',
    "or pre-existing issues outside the plan's scope.",
    '',
    'DO NOT modify any files. Report findings — do not attempt to fix the plan or the code yourself.',
    '',
    'Respond with:',
    '- VERDICT: "approve" or "revise"',
    '- A numbered list of concrete findings, each with file path and specific issue',
    '- A brief overall assessment (2-3 sentences)',
  ].filter(Boolean).join('\n');
}

export function formatPrompt({ template, task, mode, template_args }) {
  switch (template || 'general') {
    case 'general':     return formatGeneralTemplate({ task, mode });
    case 'research':    return formatResearchTemplate({ task });
    case 'plan_review': return formatPlanReviewTemplate({ template_args });
    default: throw new Error(`unknown template: ${template}`);
  }
}

// Rubber-duck cross-examination wrapper — always appended unconditionally.
// This is how rubber-duck is "always on": the server injects it for every
// send. It is NOT exposed as a tool parameter. There is no way to disable it
// through the public API.
export function appendRubberDuckReview(formatted) {
  return [
    formatted,
    '',
    '---',
    '',
    'CROSS-EXAMINATION STEP (mandatory before returning):',
    '',
    'After you have produced your initial answer, invoke the `rubber-duck` sub-agent via your `task` tool to critique your own response. Pass your draft answer as the sub-agent input along with a short copy of the original task. Ask the sub-agent to look for:',
    '  1. Claims not backed by a tool call you made in this turn (hallucinated files, functions, flags, URLs).',
    '  2. Cross-context conflation (mixing web-search results with details about the user files you did not read).',
    '  3. Overlooked edge cases or assumptions worth flagging.',
    '  4. Internal inconsistencies in the draft.',
    '',
    "Incorporate the rubber-duck's findings into your final answer. If the critique surfaces a Confirmed hallucination, REMOVE the offending claim. Prefix your final message with one of:",
    '  `RUBBER-DUCK: clean.`   (if the critique approved)',
    '  `RUBBER-DUCK: revised — <1-line summary of what you changed>.`',
    '',
    'Do NOT skip this step. It is a server-enforced, always-on quality gate.',
  ].join('\n');
}

// --- Plan path resolution ---------------------------------------------------

// PLANS_DIR can be overridden via COPILOT_PLANS_DIR for testing; otherwise
// it defaults to ~/.claude/plans. Resolved per call so tests can set the
// env var without re-importing the module.
export function getPlansDir() {
  return process.env.COPILOT_PLANS_DIR || join(homedir(), '.claude', 'plans');
}
export const PLANS_DIR = getPlansDir();

export function resolveLatestPlanPath() {
  const plansDir = getPlansDir();
  let entries;
  try { entries = readdirSync(plansDir); }
  catch (err) { throw new Error(`copilot: plans directory not readable (${plansDir}): ${err.message}`); }
  const candidates = entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => { const full = join(plansDir, f); return { full, mtimeMs: statSync(full).mtimeMs }; })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`copilot: plan_path="latest" but no .md files found in ${plansDir}`);
  }
  return candidates[0].full;
}

// --- Action boundary validation ---------------------------------------------

function assertKnownFields(action, args) {
  const allowed = ALLOWED_FIELDS[action];
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new Error(`copilot: unknown field "${key}" for action="${action}" (allowed: ${[...allowed].join(', ')})`);
    }
  }
}

function assertString(name, value, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return;
    throw new Error(`copilot: ${name} is required`);
  }
  if (typeof value !== 'string') throw new Error(`copilot: ${name} must be a string`);
}

function assertBoolean(name, value) {
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw new Error(`copilot: ${name} must be a boolean`);
}

function assertThreadName(value) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') throw new Error('copilot: thread must be a string');
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`copilot: thread must match [a-zA-Z0-9._-]+ (got "${value}")`);
  }
}

function assertCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === '') return;
  if (typeof cwd !== 'string') throw new Error('copilot: cwd must be a string');
  if (!isAbsolute(cwd)) throw new Error(`copilot: cwd must be an absolute path, got "${cwd}"`);
  let st;
  try { st = statSync(cwd); }
  catch { throw new Error(`copilot: cwd does not exist: ${cwd}`); }
  if (!st.isDirectory()) throw new Error(`copilot: cwd is not a directory: ${cwd}`);
}

// The per-action validators mutate their input where it's useful (e.g.
// plan_path "latest" → resolved absolute path) and return a normalised
// argument object. The returned shape is what the server hands off to the
// handlers; it always includes the resolved defaults.

export function validateCopilotArgs(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? rawArgs : {};
  const action = args.action;
  if (!action) throw new Error('copilot: action is required (one of: send, wait, status, reply, cancel)');
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`copilot: action must be one of send|wait|status|reply|cancel, got "${action}"`);
  }
  assertKnownFields(action, args);
  switch (action) {
    case 'send':   return validateSend(args);
    case 'wait':   return validateWait(args);
    case 'status': return validateStatus(args);
    case 'reply':  return validateReply(args);
    case 'cancel': return validateCancel(args);
    default:       throw new Error(`copilot: unhandled action "${action}"`);
  }
}

function validateReply(args) {
  // v6.1 D4: peer-steering. Both fields strictly required — there is no
  // sensible default for either.
  assertString('job_id', args.job_id);
  assertString('message', args.message);
  if (args.message.length > 8000) {
    throw new Error(`copilot: reply.message too long (${args.message.length} > 8000 chars)`);
  }
  return { action: 'reply', job_id: args.job_id, message: args.message };
}

function validateCancel(args) {
  assertString('job_id', args.job_id);
  return { action: 'cancel', job_id: args.job_id };
}

function validateWait(args) {
  assertString('job_id', args.job_id);
  if (args.max_wait_sec !== undefined && typeof args.max_wait_sec !== 'number') {
    throw new Error('copilot: max_wait_sec must be a number');
  }
  return { action: 'wait', job_id: args.job_id, max_wait_sec: args.max_wait_sec };
}

function validateStatus(args) {
  assertString('job_id', args.job_id, { optional: true });
  assertBoolean('verbose', args.verbose);
  return { action: 'status', job_id: args.job_id || null, verbose: !!args.verbose };
}

function validateSend(args) {
  const template = args.template || 'general';
  if (!VALID_TEMPLATES.has(template)) {
    throw new Error(`copilot: template must be one of ${[...VALID_TEMPLATES].join('|')}, got "${template}"`);
  }

  const mode = args.mode || DEFAULT_MODE;
  if (!VALID_MODES.has(mode)) {
    throw new Error(`copilot: mode must be one of ${[...VALID_MODES].join('|')}, got "${mode}"`);
  }

  // `task` is required for general/research; plan_review drives its prompt
  // from plan_path and ignores task.
  const needsTask = template === 'general' || template === 'research';
  if (needsTask) assertString('task', args.task);
  if (!needsTask && args.task) {
    log('WARN', 'copilot: task ignored for template="plan_review"');
  }

  const ta = args.template_args ?? {};
  if (typeof ta !== 'object' || Array.isArray(ta)) {
    throw new Error('copilot: template_args must be a plain object');
  }
  for (const key of Object.keys(ta)) {
    if (!VALID_TEMPLATE_ARGS_KEYS.has(key)) {
      throw new Error(`copilot: unknown template_args key "${key}" (allowed: ${[...VALID_TEMPLATE_ARGS_KEYS].join(', ')})`);
    }
  }

  if (template === 'plan_review') {
    if (!ta.plan_path || typeof ta.plan_path !== 'string') {
      throw new Error(
        'copilot: template="plan_review" requires template_args.plan_path ' +
        '(absolute path to the plan .md file, or "latest")',
      );
    }
    if (ta.plan_path === 'latest') {
      ta.plan_path = resolveLatestPlanPath();
      log('INFO', 'copilot:', `plan_path=latest resolved to ${ta.plan_path}`);
    }
    if (ta.plan_path.includes('<') || ta.plan_path.includes('>')) {
      throw new Error(`copilot: template_args.plan_path looks like an un-substituted placeholder: "${ta.plan_path}"`);
    }
    if (!isAbsolute(ta.plan_path)) {
      throw new Error(`copilot: template_args.plan_path must be absolute, got "${ta.plan_path}"`);
    }
    let st;
    try { st = statSync(ta.plan_path); }
    catch { throw new Error(`copilot: template_args.plan_path does not exist: ${ta.plan_path}`); }
    if (!st.isFile()) throw new Error(`copilot: template_args.plan_path is not a file: ${ta.plan_path}`);
    // v6.1 A8: resolve symlinks and verify the real path is inside PLANS_DIR.
    // Without this, a symlink at ~/.claude/plans/foo.md → /etc/passwd would
    // be passed verbatim to the prompt template and read by Copilot.
    let realPath;
    try { realPath = realpathSync(ta.plan_path); }
    catch { throw new Error(`copilot: template_args.plan_path could not be resolved: ${ta.plan_path}`); }
    const realPlansDir = (() => { try { return realpathSync(getPlansDir()); } catch { return getPlansDir(); } })();
    const inside = realPath === realPlansDir || realPath.startsWith(realPlansDir + pathSep);
    if (!inside) {
      throw new Error(`copilot: template_args.plan_path resolves outside ${getPlansDir()}: ${realPath}`);
    }
    ta.plan_path = realPath;
    if (ta.focus_directive !== undefined && typeof ta.focus_directive !== 'string') {
      throw new Error('copilot: template_args.focus_directive must be a string');
    }
  } else if (Object.keys(ta).length > 0) {
    log('WARN', 'copilot:', `template="${template}" ignores template_args (received keys: ${Object.keys(ta).join(', ')})`);
  }

  assertCwd(args.cwd);
  assertThreadName(args.thread);

  if (args.max_wait_sec !== undefined && typeof args.max_wait_sec !== 'number') {
    throw new Error('copilot: max_wait_sec must be a number');
  }

  return {
    action: 'send',
    task: needsTask ? args.task : null,
    mode,
    template,
    template_args: ta,
    cwd: args.cwd || null,
    thread: args.thread || null,
    max_wait_sec: args.max_wait_sec,
  };
}
