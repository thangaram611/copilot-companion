// Host detection + per-host path resolution tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  detectHost,
  _resetHostCacheForTests,
  companionHomeDir,
  plansDir,
  agentsDir,
  settingsFile,
  pluginRootEnvVar,
  sessionIdEnvVar,
  sanitizeHostSessionId,
} from './host.mjs';

function withEnv(key, value, fn) {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  _resetHostCacheForTests();
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
    _resetHostCacheForTests();
  }
}

test('detectHost defaults to claude when env unset', () => {
  withEnv('COPILOT_COMPANION_HOST', undefined, () => {
    assert.equal(detectHost(), 'claude');
  });
});

test('detectHost returns codex when env=codex', () => {
  withEnv('COPILOT_COMPANION_HOST', 'codex', () => {
    assert.equal(detectHost(), 'codex');
  });
});

test('detectHost falls back to claude on invalid value', () => {
  withEnv('COPILOT_COMPANION_HOST', 'gemini', () => {
    assert.equal(detectHost(), 'claude');
  });
});

test('detectHost trims whitespace before validating', () => {
  withEnv('COPILOT_COMPANION_HOST', '  codex  ', () => {
    assert.equal(detectHost(), 'codex');
  });
});

test('detectHost is memoized — env change after first call has no effect', () => {
  withEnv('COPILOT_COMPANION_HOST', 'codex', () => {
    assert.equal(detectHost(), 'codex');
    process.env.COPILOT_COMPANION_HOST = 'claude';
    // No cache reset → still codex.
    assert.equal(detectHost(), 'codex');
  });
});

test('companionHomeDir returns per-host path', () => {
  assert.equal(companionHomeDir('claude'), join(homedir(), '.claude', 'copilot-companion'));
  assert.equal(companionHomeDir('codex'), join(homedir(), '.codex', 'copilot-companion'));
});

test('plansDir returns per-host path', () => {
  assert.equal(plansDir('claude'), join(homedir(), '.claude', 'plans'));
  assert.equal(plansDir('codex'), join(homedir(), '.codex', 'plans'));
});

test('agentsDir returns per-host path', () => {
  assert.equal(agentsDir('claude'), join(homedir(), '.claude', 'agents'));
  assert.equal(agentsDir('codex'), join(homedir(), '.codex', 'agents'));
});

test('settingsFile returns per-host path', () => {
  assert.equal(settingsFile('claude'), join(homedir(), '.claude', 'settings.json'));
  assert.equal(settingsFile('codex'), join(homedir(), '.codex', 'config.toml'));
});

test('pluginRootEnvVar — both hosts use CLAUDE_PLUGIN_ROOT (codex compat alias)', () => {
  assert.equal(pluginRootEnvVar('claude'), 'CLAUDE_PLUGIN_ROOT');
  assert.equal(pluginRootEnvVar('codex'), 'CLAUDE_PLUGIN_ROOT');
});

test('sessionIdEnvVar reflects host', () => {
  assert.equal(sessionIdEnvVar('claude'), 'CLAUDE_CODE_SESSION_ID');
  assert.equal(sessionIdEnvVar('codex'), 'CODEX_SESSION_ID');
});

test('sanitizeHostSessionId passes safe ids verbatim', () => {
  assert.equal(sanitizeHostSessionId('019e0dc8-94b3-7172-abeb-60578f8a8a8d'),
               '019e0dc8-94b3-7172-abeb-60578f8a8a8d');
  assert.equal(sanitizeHostSessionId('abc.def_ghi-jkl'), 'abc.def_ghi-jkl');
});

test('sanitizeHostSessionId replaces unsafe runs with single underscore', () => {
  assert.equal(sanitizeHostSessionId('a/b\\c d:e'), 'a_b_c_d_e');
  assert.equal(sanitizeHostSessionId('a//b'), 'a_b');
});

test('sanitizeHostSessionId handles empty/null', () => {
  assert.equal(sanitizeHostSessionId(''), '');
  assert.equal(sanitizeHostSessionId(null), '');
  assert.equal(sanitizeHostSessionId(undefined), '');
  assert.equal(sanitizeHostSessionId(42), '');
});
