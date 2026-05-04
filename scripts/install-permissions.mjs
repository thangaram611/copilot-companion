#!/usr/bin/env node
// install-permissions.mjs — idempotently grant the copilot-bridge MCP tool
// permission in ~/.claude/settings.json. Pure Node ≥20 (no jq dependency);
// relies only on the Node version setup.sh already verifies.
//
// Usage:
//   node scripts/install-permissions.mjs            # interactive y/N
//   node scripts/install-permissions.mjs --yes      # non-interactive (used by setup.sh)
//
// Exit codes: 0 success / already present, 1 user-aborted or non-tty without --yes,
// 2 malformed settings.json (parse error or wrong shape).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

const TOOL = 'mcp__copilot-bridge__copilot';
const SETTINGS = path.join(homedir(), '.claude', 'settings.json');
const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');

const ok = (m) => console.log(`[OK]   ${m}`);
const fail = (m, code = 1) => {
  console.error(`[FAIL] ${m}`);
  process.exit(code);
};

mkdirSync(path.dirname(SETTINGS), { recursive: true });

let cfg = {};
if (existsSync(SETTINGS)) {
  let raw;
  try {
    raw = readFileSync(SETTINGS, 'utf8');
  } catch (e) {
    fail(`cannot read ${SETTINGS}: ${e.message}`, 2);
  }
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    fail(`${SETTINGS} is not valid JSON: ${e.message}. Fix manually before re-running.`, 2);
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    fail(`${SETTINGS} top-level must be a JSON object`, 2);
  }
}

if (
  !cfg.permissions ||
  typeof cfg.permissions !== 'object' ||
  Array.isArray(cfg.permissions)
) {
  cfg.permissions = {};
}
const allow = Array.isArray(cfg.permissions.allow)
  ? cfg.permissions.allow.slice()
  : [];

if (allow.includes(TOOL)) {
  ok(`${TOOL} already in ${SETTINGS}`);
  process.exit(0);
}

if (!yes && !process.stdin.isTTY) {
  fail('interactive confirmation required but stdin is not a tty; pass --yes', 1);
}

if (!yes) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ans = (await rl.question(`Add ${TOOL} to ${SETTINGS}? [y/N] `))
    .trim()
    .toLowerCase();
  rl.close();
  if (ans !== 'y' && ans !== 'yes') {
    console.log('aborted');
    process.exit(1);
  }
}

allow.push(TOOL);
cfg.permissions.allow = allow;

const ts = new Date()
  .toISOString()
  .replace(/[-:T.]/g, '')
  .slice(0, 14);
const backup = `${SETTINGS}.bak.${ts}`;
const hadExisting = existsSync(SETTINGS);
if (hadExisting) copyFileSync(SETTINGS, backup);
const tmp = `${SETTINGS}.tmp.${process.pid}`;
writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
renameSync(tmp, SETTINGS);
ok(`added ${TOOL}${hadExisting ? ` (backup: ${backup})` : ''}`);
