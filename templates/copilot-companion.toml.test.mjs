// Schema/structural sanity tests for templates/copilot-companion.toml.
//
// We don't pull in a TOML parser dep just for this — but a TOML key=value
// pair declared after a `[table.section]` header is parsed as part of
// that table, not as a top-level key. That single foot-gun caused the
// developer_instructions key to silently disappear into the
// `[mcp_servers.copilot-bridge]` table during initial drafting. These
// regex checks lock the structural invariants that matter:
//   - the three required fields are at the top level (declared before
//     any `[...]` table header)
//   - the bridge MCP table declares the right command/args/env
//   - the COPILOT_COMPANION_HOST literal is "codex" (the route signal
//     that lib/host.mjs reads on startup)
//
// If a future edit ever pulls @iarna/toml or a built-in TOML parser into
// scope, replace these checks with a real parse + structural assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOML_PATH = join(HERE, 'copilot-companion.toml');
const text = readFileSync(TOML_PATH, 'utf8');

// Slice out everything that comes BEFORE the first [table] header — that
// is where TOML expects top-level keys.
const firstTableIdx = text.search(/^\[[a-zA-Z_]/m);
assert.notEqual(firstTableIdx, -1, 'TOML must declare at least one table');
const topLevel = text.slice(0, firstTableIdx);

test('top-level: name = "copilot-companion"', () => {
  assert.match(topLevel, /^name\s*=\s*"copilot-companion"\s*$/m);
});

test('top-level: description present (multi-line """ block)', () => {
  assert.match(topLevel, /^description\s*=\s*"""/m);
});

test('top-level: developer_instructions present (multi-line """ block)', () => {
  // This is the one most likely to drift below a [table] section by
  // accident. Keeping it strictly above the first table header guards
  // against silent misparse.
  assert.match(topLevel, /^developer_instructions\s*=\s*"""/m);
});

test('top-level: model is allowlisted in lib/state.mjs', async () => {
  const match = topLevel.match(/^model\s*=\s*"([^"]+)"\s*$/m);
  assert.ok(match, 'model field present at top level');
  const state = await import('../lib/state.mjs');
  assert.equal(state.isModelAllowed(match[1]), true,
    `model ${match[1]} must be in ALLOWED_MODELS`);
});

test('mcp_servers.copilot-bridge: declares command = "node"', () => {
  assert.match(text, /^\[mcp_servers\.copilot-bridge\]\s*$/m);
  // Anchor the assertion to the table by walking from the header forward.
  const tableStart = text.indexOf('[mcp_servers.copilot-bridge]');
  const tableEnd = text.length;
  const tableBody = text.slice(tableStart, tableEnd);
  assert.match(tableBody, /^command\s*=\s*"node"\s*$/m);
});

test('mcp_servers.copilot-bridge: args points at bridge-server/server.mjs under CLAUDE_PLUGIN_ROOT', () => {
  const tableStart = text.indexOf('[mcp_servers.copilot-bridge]');
  const tableBody = text.slice(tableStart);
  assert.match(tableBody,
    /^args\s*=\s*\[\s*"\$\{CLAUDE_PLUGIN_ROOT\}\/bridge-server\/server\.mjs"\s*\]\s*$/m,
    'args[0] must reference ${CLAUDE_PLUGIN_ROOT}/bridge-server/server.mjs — the install hook substitutes this at materialization time');
});

test('mcp_servers.copilot-bridge: env declares COPILOT_COMPANION_HOST = "codex"', () => {
  // The literal env value is what lib/host.mjs reads on startup to route
  // paths under ~/.codex/. If this drifts to "claude" or gets dropped,
  // the Codex install will write into the Claude state directory.
  const tableStart = text.indexOf('[mcp_servers.copilot-bridge]');
  const tableBody = text.slice(tableStart);
  assert.match(tableBody, /COPILOT_COMPANION_HOST\s*=\s*"codex"/);
  assert.match(tableBody, /MCP_TOOL_TIMEOUT\s*=\s*"540000"/);
});

test('TOML never references CLAUDE_CODE_SESSION_ID — Codex uses MCP _meta', () => {
  // The Claude template tells the agent to forward CLAUDE_CODE_SESSION_ID
  // by hand. The Codex template must NOT carry that instruction, since
  // session id is read server-side from MCP _meta.
  assert.doesNotMatch(text, /CLAUDE_CODE_SESSION_ID/,
    'Codex template should not mention CLAUDE_CODE_SESSION_ID');
});

test('developer_instructions: references Codex-specific multi-agent verbs', () => {
  // spawn_agent / send_input / resume_agent are the Codex equivalents of
  // Agent() / SendMessage() — make sure we ported the language.
  const di = text.match(/^developer_instructions\s*=\s*"""([\s\S]*?)"""/m);
  assert.ok(di, 'developer_instructions block extractable');
  const body = di[1];
  assert.match(body, /spawn_agent/);
  assert.match(body, /send_input/);
  assert.doesNotMatch(body, /\bAgent\(\)/, 'Claude-specific Agent() call should be replaced');
  assert.doesNotMatch(body, /SendMessage\(\)/, 'Claude-specific SendMessage() should be replaced');
});
