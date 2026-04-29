// Validation tests for the single `copilot` tool. Pure-function —
// no sockets, no daemon, no state-layer side effects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateCopilotArgs,
  VALID_ACTIONS,
  VALID_MODES,
  VALID_TEMPLATES,
  DEFAULT_MODE,
  formatPrompt,
  appendRubberDuckReview,
} from './validation.mjs';

// ---------- action discriminator ----------

test('action is required', () => {
  assert.throws(() => validateCopilotArgs({}), /action is required/);
});

test('action must be one of known', () => {
  assert.throws(() => validateCopilotArgs({ action: 'launch' }), /action must be one of/);
});

test('known action set is stable', () => {
  assert.deepEqual([...VALID_ACTIONS].sort(), ['cancel', 'reply', 'send', 'status', 'wait']);
});

// ---------- cancel ----------

test('cancel requires job_id', () => {
  assert.throws(() => validateCopilotArgs({ action: 'cancel' }), /job_id/);
});

test('cancel accepts job_id', () => {
  const r = validateCopilotArgs({ action: 'cancel', job_id: 'abc-123' });
  assert.equal(r.job_id, 'abc-123');
});

test('cancel rejects unknown fields', () => {
  assert.throws(() => validateCopilotArgs({ action: 'cancel', job_id: 'x', model: 'm' }), /unknown field "model"/);
});

// ---------- wait ----------

test('wait requires job_id', () => {
  assert.throws(() => validateCopilotArgs({ action: 'wait' }), /job_id/);
});

test('wait accepts job_id + max_wait_sec', () => {
  const r = validateCopilotArgs({ action: 'wait', job_id: 'j', max_wait_sec: 120 });
  assert.equal(r.job_id, 'j');
  assert.equal(r.max_wait_sec, 120);
});

test('wait rejects non-number max_wait_sec', () => {
  assert.throws(() => validateCopilotArgs({ action: 'wait', job_id: 'j', max_wait_sec: 'x' }), /max_wait_sec/);
});

// ---------- status ----------

test('status allows verbose + job_id', () => {
  const r = validateCopilotArgs({ action: 'status', job_id: 'j', verbose: true });
  assert.equal(r.verbose, true);
  assert.equal(r.job_id, 'j');
});

test('status rejects non-boolean verbose', () => {
  assert.throws(() => validateCopilotArgs({ action: 'status', verbose: 'yes' }), /verbose must be a boolean/);
});

// ---------- send: defaults + unknown fields ----------

test('send requires task for general template', () => {
  assert.throws(() => validateCopilotArgs({ action: 'send' }), /task is required/);
});

test('send applies mode/template defaults', () => {
  const r = validateCopilotArgs({ action: 'send', task: 'x' });
  assert.equal(r.mode, DEFAULT_MODE);
  assert.equal(r.template, 'general');
});

test('send rejects unknown top-level fields (e.g. model, rubber_duck)', () => {
  assert.throws(() => validateCopilotArgs({ action: 'send', task: 'x', model: 'gpt-5.4' }), /unknown field "model"/);
  assert.throws(() => validateCopilotArgs({ action: 'send', task: 'x', rubber_duck: false }), /unknown field "rubber_duck"/);
});

test('send rejects invalid mode/template', () => {
  assert.throws(() => validateCopilotArgs({ action: 'send', task: 'x', mode: 'write' }), /mode must be one of/);
  assert.throws(() => validateCopilotArgs({ action: 'send', task: 'x', template: 'fleet' }), /template must be one of/);
});

test('send accepts every valid mode', () => {
  for (const mode of VALID_MODES) {
    const r = validateCopilotArgs({ action: 'send', task: 'x', mode });
    assert.equal(r.mode, mode);
  }
});

// ---------- send: thread validation ----------

test('thread accepts valid slug', () => {
  const r = validateCopilotArgs({ action: 'send', task: 'x', thread: 'my_branch.01-a' });
  assert.equal(r.thread, 'my_branch.01-a');
});

test('thread rejects path traversal', () => {
  assert.throws(() => validateCopilotArgs({ action: 'send', task: 'x', thread: '../etc' }), /thread must match/);
  assert.throws(() => validateCopilotArgs({ action: 'send', task: 'x', thread: 'a/b' }), /thread must match/);
});

// ---------- send: cwd validation ----------

test('cwd must be absolute', () => {
  assert.throws(() => validateCopilotArgs({ action: 'send', task: 'x', cwd: 'relative/path' }), /cwd must be an absolute path/);
});

test('cwd must exist as dir', () => {
  assert.throws(() => validateCopilotArgs({ action: 'send', task: 'x', cwd: '/__nope__/__nope__' }), /cwd does not exist/);
});

// ---------- plan_review template ----------

test('plan_review requires plan_path', () => {
  assert.throws(() => validateCopilotArgs({ action: 'send', template: 'plan_review' }),
    /requires template_args\.plan_path/);
});

test('plan_review rejects non-absolute plan_path', () => {
  assert.throws(() =>
    validateCopilotArgs({ action: 'send', template: 'plan_review', template_args: { plan_path: 'rel.md' } }),
    /plan_path must be absolute/,
  );
});

test('plan_review rejects unsubstituted placeholders', () => {
  assert.throws(() =>
    validateCopilotArgs({ action: 'send', template: 'plan_review', template_args: { plan_path: '/tmp/<foo>.md' } }),
    /un-substituted placeholder/,
  );
});

test('plan_review accepts real file + focus_directive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-plan-'));
  const f = join(dir, 'plan.md');
  writeFileSync(f, '# plan');
  const prev = process.env.COPILOT_PLANS_DIR;
  process.env.COPILOT_PLANS_DIR = dir;
  try {
    const r = validateCopilotArgs({
      action: 'send',
      template: 'plan_review',
      template_args: { plan_path: f, focus_directive: 'security' },
    });
    assert.equal(r.template, 'plan_review');
    // plan_path is canonicalised via realpathSync — compare against the
    // realpath of the input (mkdtempSync may return a path with /private
    // prefix on macOS).
    assert.equal(r.template_args.focus_directive, 'security');
    assert.equal(r.task, null);
    assert.ok(r.template_args.plan_path.endsWith('plan.md'));
  } finally {
    if (prev === undefined) delete process.env.COPILOT_PLANS_DIR;
    else process.env.COPILOT_PLANS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan_review rejects unknown template_args keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-plan-'));
  const f = join(dir, 'plan.md'); writeFileSync(f, '# plan');
  const prev = process.env.COPILOT_PLANS_DIR;
  process.env.COPILOT_PLANS_DIR = dir;
  try {
    assert.throws(() =>
      validateCopilotArgs({
        action: 'send',
        template: 'plan_review',
        template_args: { plan_path: f, bogus_key: 'x' },
      }),
      /unknown template_args key "bogus_key"/,
    );
  } finally {
    if (prev === undefined) delete process.env.COPILOT_PLANS_DIR;
    else process.env.COPILOT_PLANS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- v6.1 A8: symlink escape ----------

test('plan_review rejects symlink escape (A8)', async () => {
  const { symlinkSync } = await import('node:fs');
  const insideDir = mkdtempSync(join(tmpdir(), 'copilot-plans-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'copilot-out-'));
  const target = join(outsideDir, 'secret.md');
  writeFileSync(target, '# secret');
  const link = join(insideDir, 'innocent.md');
  symlinkSync(target, link);
  const prev = process.env.COPILOT_PLANS_DIR;
  process.env.COPILOT_PLANS_DIR = insideDir;
  try {
    assert.throws(() =>
      validateCopilotArgs({
        action: 'send',
        template: 'plan_review',
        template_args: { plan_path: link },
      }),
      /resolves outside/,
    );
  } finally {
    if (prev === undefined) delete process.env.COPILOT_PLANS_DIR;
    else process.env.COPILOT_PLANS_DIR = prev;
    rmSync(insideDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ---------- template formatters ----------

test('formatPrompt general contains TASK and mode label', () => {
  const out = formatPrompt({ template: 'general', task: 'do thing', mode: 'EXECUTE' });
  assert.match(out, /TASK: do thing/);
  assert.match(out, /Mode: EXECUTE/);
});

test('PLAN mode tells Copilot to not modify files', () => {
  const out = formatPrompt({ template: 'general', task: 't', mode: 'PLAN' });
  assert.match(out, /Do not modify any files/);
  assert.match(out, /numbered implementation plan/);
});

test('ANALYZE mode is read-only', () => {
  const out = formatPrompt({ template: 'general', task: 't', mode: 'ANALYZE' });
  assert.match(out, /Do not modify any files/);
});

test('research template never references shell/edit', () => {
  const out = formatPrompt({ template: 'research', task: 'what is X' });
  assert.match(out, /research assistant/);
  assert.doesNotMatch(out, /`edit`/);
});

test('appendRubberDuckReview includes required cross-examination marker', () => {
  const out = appendRubberDuckReview('BASE');
  assert.match(out, /CROSS-EXAMINATION STEP/);
  assert.match(out, /RUBBER-DUCK: clean\./);
  assert.match(out, /RUBBER-DUCK: revised/);
});

// ---------- sanity: templates stable ----------

test('VALID_TEMPLATES matches spec', () => {
  assert.deepEqual([...VALID_TEMPLATES].sort(), ['general', 'plan_review', 'research']);
});

// ---------- v6.1 D: reply action ----------

test('reply requires job_id', () => {
  assert.throws(() => validateCopilotArgs({ action: 'reply', message: 'hi' }), /job_id/);
});

test('reply requires message', () => {
  assert.throws(() => validateCopilotArgs({ action: 'reply', job_id: 'job-1' }), /message/);
});

test('reply rejects empty message', () => {
  assert.throws(() => validateCopilotArgs({ action: 'reply', job_id: 'job-1', message: '' }), /message/);
});

test('reply rejects oversized message', () => {
  const big = 'x'.repeat(8001);
  assert.throws(
    () => validateCopilotArgs({ action: 'reply', job_id: 'job-1', message: big }),
    /too long/,
  );
});

test('reply accepts valid input', () => {
  const r = validateCopilotArgs({ action: 'reply', job_id: 'job-1', message: 'add tests' });
  assert.equal(r.action, 'reply');
  assert.equal(r.job_id, 'job-1');
  assert.equal(r.message, 'add tests');
});

test('reply rejects unknown fields', () => {
  assert.throws(
    () => validateCopilotArgs({ action: 'reply', job_id: 'j', message: 'm', thread: 'x' }),
    /unknown field/,
  );
});

// ---------- v6.1 B4: appendRubberDuckReview is template-blind ----------
// (the per-template skip is enforced server-side in runWorker; the wrapper
// itself remains a pure decorator.)

test('appendRubberDuckReview always wraps when called', () => {
  const wrapped = appendRubberDuckReview('hello');
  assert.match(wrapped, /CROSS-EXAMINATION STEP/);
  assert.match(wrapped, /^hello\n/);
});
