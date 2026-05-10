// Tests for scripts/install-codex-hooks.mjs.
//
// We invoke the script as a subprocess (vs. importing) for two reasons:
//   1. It calls process.exit() on confirmation paths, which would tear
//      down the test runner.
//   2. HOME-rooted path resolution at module load is what we want to
//      exercise — running as a child gives a clean env.
//
// All tests run against a tmp HOME so the user's real ~/.codex/hooks.json
// is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'install-codex-hooks.mjs');
const PLUGIN_ROOT = dirname(HERE); // repo root

function runScript(home, extraArgs = []) {
  const args = [SCRIPT, '--plugin-root', PLUGIN_ROOT, '--yes', ...extraArgs];
  const r = spawnSync(process.execPath, args, {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readHooks(home) {
  return JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'codex-hooks-test-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('--plugin-root is required', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-hooks-test-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--yes'], {
      env: { ...process.env, HOME: home }, encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--plugin-root/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--plugin-root must be absolute', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-hooks-test-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--plugin-root', 'rel/path', '--yes'], {
      env: { ...process.env, HOME: home }, encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must be absolute/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('fresh install creates ~/.codex/hooks.json with all three events', () => {
  withHome((home) => {
    const r = runScript(home);
    assert.equal(r.code, 0, r.stderr);
    const cfg = readHooks(home);
    assert.ok(cfg.hooks.SessionStart);
    assert.ok(cfg.hooks.UserPromptSubmit);
    assert.ok(cfg.hooks.PostToolUse);
    // Each event has exactly one managed top-level entry on a fresh install.
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
      const managed = cfg.hooks[ev].filter((e) => e._managed_by === 'copilot-companion');
      assert.equal(managed.length, 1, `${ev} has exactly one managed entry`);
    }
  });
});

test('hook commands embed plugin-root absolute path (no ${VAR} placeholders)', () => {
  withHome((home) => {
    runScript(home);
    const cfg = readHooks(home);
    const cmd = cfg.hooks.SessionStart[0].hooks[0].command;
    assert.match(cmd, /^CLAUDE_PLUGIN_ROOT='/);
    assert.ok(cmd.includes(PLUGIN_ROOT), 'plugin-root absolute path baked in');
    assert.doesNotMatch(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}/,
      'no ${VAR} placeholder — Codex does not expand env vars in user-scope hooks');
  });
});

test('idempotent re-install: managed entry count stays at 1 per event', () => {
  withHome((home) => {
    runScript(home);
    runScript(home);
    runScript(home);
    const cfg = readHooks(home);
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
      const managed = cfg.hooks[ev].filter((e) => e._managed_by === 'copilot-companion');
      assert.equal(managed.length, 1, `${ev} still has 1 managed entry after 3 installs`);
    }
  });
});

test('merge preserves pre-existing user hooks', () => {
  withHome((home) => {
    // Seed a user-managed hooks.json
    const f = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '/usr/local/bin/user-script.sh', timeout: 5 }],
        }],
        UserPromptSubmit: [{
          hooks: [{ type: 'command', command: 'echo user-hook' }],
        }],
      },
    }, null, 2));

    runScript(home);
    const cfg = readHooks(home);

    // User's SessionStart entry must still be there.
    const userSS = cfg.hooks.SessionStart.find((e) =>
      e.hooks?.[0]?.command === '/usr/local/bin/user-script.sh');
    assert.ok(userSS, 'user SessionStart entry preserved');
    assert.notEqual(userSS._managed_by, 'copilot-companion',
      'user entry was not tagged with our sentinel');

    // Our entry sits alongside it.
    const ours = cfg.hooks.SessionStart.filter((e) => e._managed_by === 'copilot-companion');
    assert.equal(ours.length, 1);
    assert.equal(cfg.hooks.SessionStart.length, 2,
      'one user entry + one managed entry = 2');
  });
});

test('backup written before each modification when file existed', () => {
  withHome((home) => {
    runScript(home);
    const beforeRe = readdirSync(join(home, '.codex'));
    assert.equal(beforeRe.filter((f) => /hooks\.json\.bak\./.test(f)).length, 0,
      'no backup on initial install (file did not exist)');

    runScript(home);
    const afterRe = readdirSync(join(home, '.codex'));
    assert.equal(afterRe.filter((f) => /hooks\.json\.bak\./.test(f)).length, 1,
      'backup written on second install (file existed)');
  });
});

test('uninstall removes only managed entries, preserves user entries', () => {
  withHome((home) => {
    // Seed user hooks
    const f = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '/usr/local/bin/user-script.sh' }],
        }],
      },
    }, null, 2));

    runScript(home);
    runScript(home, ['--uninstall']);

    const cfg = readHooks(home);
    assert.equal(cfg.hooks.SessionStart.length, 1, 'user entry survives');
    assert.equal(cfg.hooks.SessionStart[0].hooks[0].command,
      '/usr/local/bin/user-script.sh');
    assert.equal(cfg.hooks.UserPromptSubmit, undefined,
      'event keys with no remaining entries are removed');
    assert.equal(cfg.hooks.PostToolUse, undefined);
  });
});

test('malformed hooks.json aborts with exit 2 (no overwrite)', () => {
  withHome((home) => {
    const f = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '{ this is not json');
    const r = runScript(home);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not valid JSON/);
    // Original content untouched.
    assert.equal(readFileSync(f, 'utf8'), '{ this is not json');
  });
});

test('SessionStart hook bundle includes all four scripts in order', () => {
  withHome((home) => {
    runScript(home);
    const cfg = readHooks(home);
    const ours = cfg.hooks.SessionStart.find((e) => e._managed_by === 'copilot-companion');
    const cmds = ours.hooks.map((h) => h.command);
    assert.match(cmds[0], /install-agent-codex\.sh/);
    assert.match(cmds[1], /prewarm-daemon\.sh/);
    assert.match(cmds[2], /install-deps\.sh/);
    assert.match(cmds[3], /drain-completions\.sh/);
    // install-deps gets 55s; the rest get 5s.
    assert.equal(ours.hooks[2].timeout, 55);
    for (const i of [0, 1, 3]) assert.equal(ours.hooks[i].timeout, 5);
  });
});

test('PostToolUse entry has matcher = ".*"', () => {
  withHome((home) => {
    runScript(home);
    const cfg = readHooks(home);
    const ours = cfg.hooks.PostToolUse.find((e) => e._managed_by === 'copilot-companion');
    assert.equal(ours.matcher, '.*');
  });
});
