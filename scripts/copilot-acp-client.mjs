#!/usr/bin/env node
// copilot-acp-client.mjs
// Stateless CLI client for the copilot-acp-daemon. Communicates over a Unix
// domain socket using newline-delimited JSON. Auto-spawns the daemon if not
// running. All output is single-line JSON to stdout.

import { connect as connectSocket } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

import { socketPath, ensureRuntimeDir } from '../lib/paths.mjs';

const SOCKET_PATH = socketPath();
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = pathResolve(__dirname, 'copilot-acp-daemon.mjs');
const DAEMON_BOOT_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 6 * 60 * 1000; // a bit longer than daemon's prompt timeout

// --- Socket I/O --------------------------------------------------------------

function sendToSocket(message, timeoutMs = REQUEST_TIMEOUT_MS) {
  // Establish the per-user 0o700 runtime dir BEFORE every connect.
  // Centralized here so any code path that reaches the socket — status,
  // watch, inspect, cancel, forget, stop, prompt-* — gets the security
  // boundary verified, even when invoked standalone without going
  // through ensureDaemon. Closes the same pre-bound rogue socket attack
  // class as the bridge-side fix in daemon-client.mjs.
  ensureRuntimeDir();
  return new Promise((resolve, reject) => {
    const sock = connectSocket(SOCKET_PATH);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('client request timeout'));
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(message));
      sock.end(); // half-close: tells server we're done writing
    });
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => (buf += chunk));
    sock.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.trim()));
      } catch (err) {
        reject(new Error(`invalid response from daemon: ${err.message}`));
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- Daemon lifecycle --------------------------------------------------------

async function isDaemonAlive() {
  try {
    const r = await sendToSocket({ command: 'status' });
    return r && r.ok === true;
  } catch {
    return false;
  }
}

async function spawnDaemon() {
  if (!existsSync(DAEMON_PATH)) {
    throw new Error(`daemon not found at ${DAEMON_PATH}`);
  }
  const child = spawn('node', [DAEMON_PATH], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Poll for socket availability
  const start = Date.now();
  while (Date.now() - start < DAEMON_BOOT_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isDaemonAlive()) return;
  }
  throw new Error('daemon failed to start within timeout');
}

async function ensureDaemon() {
  if (await isDaemonAlive()) return;
  await spawnDaemon();
}

// --- Subcommand handlers -----------------------------------------------------

async function cmdStart(args) {
  await ensureDaemon();
  const cwd = parseFlag(args, '--cwd') || process.cwd();
  return sendToSocket({ command: 'start', cwd });
}

async function cmdPrompt(args) {
  await ensureDaemon();
  const sessionId = args[0];
  const text = args.slice(1).join(' ');
  if (!sessionId || !text) throw new Error('usage: prompt <sessionId> <text>');
  return sendToSocket({ command: 'prompt', sessionId, text });
}

async function cmdPromptAuto(args) {
  await ensureDaemon();
  const cwd = parseFlag(args, '--cwd') || process.cwd();
  const text = args.filter((a, i, arr) => !(a === '--cwd' || arr[i - 1] === '--cwd')).join(' ');
  if (!text) throw new Error('usage: prompt-auto <text>');
  return sendToSocket({ command: 'prompt-auto', cwd, text });
}

// Background prompt: returns immediately with promptId. Use `watch` to poll
// progress and `cancel` to interrupt. Optional --session <sid> to use an
// existing session; otherwise a new session is created.
async function cmdPromptBg(args) {
  await ensureDaemon();
  const cwd = parseFlag(args, '--cwd') || process.cwd();
  const sessionId = parseFlag(args, '--session');
  const text = args
    .filter((a, i, arr) => {
      if (a === '--cwd' || a === '--session') return false;
      if (arr[i - 1] === '--cwd' || arr[i - 1] === '--session') return false;
      return true;
    })
    .join(' ');
  if (!text) throw new Error('usage: prompt-bg [--session <sid>] [--cwd <path>] <text>');
  return sendToSocket({ command: 'prompt-bg', cwd, sessionId, text });
}

// Watch a background prompt. --since N starts from event line N (default 0).
// By default, consecutive thought/message chunks are coalesced into single
// events to reduce the size of the JSON response. Pass --raw to disable.
// Response includes new events, status, and the final summary if completed.
async function cmdWatch(args) {
  if (!(await isDaemonAlive())) throw new Error('daemon not running');
  const promptId = args[0];
  if (!promptId) {
    throw new Error('usage: watch <promptId> [--since <N>] [--raw] [--wait <sec>] [--summary-only]');
  }
  const since = parseInt(parseFlag(args, '--since') || '0', 10);
  const wait = parseInt(parseFlag(args, '--wait') || '0', 10);
  const summaryOnly = args.includes('--summary-only');
  const raw = args.includes('--raw');
  // When long-polling, extend the socket read deadline so the client doesn't
  // time out before the daemon resolves the waiter. Cap at 9 min to stay
  // safely under the daemon's 10-min inactivity shutdown.
  const timeoutMs = wait > 0
    ? Math.min((wait + 30) * 1000, 9 * 60 * 1000)
    : REQUEST_TIMEOUT_MS;
  return sendToSocket({ command: 'watch', promptId, since, raw, wait, summaryOnly }, timeoutMs);
}

async function cmdInspect(args) {
  if (!(await isDaemonAlive())) throw new Error('daemon not running');
  const promptId = args[0];
  if (!promptId) throw new Error('usage: inspect <promptId> [--limit <N>]');
  const limit = parseInt(parseFlag(args, '--limit') || '40', 10);
  return sendToSocket({ command: 'inspect', promptId, includeTimeline: true, limit });
}

// `await <promptId> [--max-wait <sec>]` is sugar for the long-poll +
// summary-only path. The copilot-bridge MCP server uses this from its
// internal worker so it never has to manage polling, offsets, or coalescing.
async function cmdAwait(args) {
  if (!(await isDaemonAlive())) throw new Error('daemon not running');
  const promptId = args[0];
  if (!promptId) throw new Error('usage: await <promptId> [--max-wait <sec>]');
  const maxWait = parseInt(parseFlag(args, '--max-wait') || '480', 10);
  const timeoutMs = Math.min((maxWait + 30) * 1000, 9 * 60 * 1000);
  return sendToSocket(
    { command: 'watch', promptId, since: 0, raw: false, wait: maxWait, summaryOnly: true },
    timeoutMs,
  );
}

async function cmdCancel(args) {
  if (!(await isDaemonAlive())) throw new Error('daemon not running');
  const promptId = args[0];
  if (!promptId) throw new Error('usage: cancel <promptId>');
  return sendToSocket({ command: 'cancel', promptId });
}

async function cmdForget(args) {
  if (!(await isDaemonAlive())) throw new Error('daemon not running');
  const promptId = args[0];
  if (!promptId) throw new Error('usage: forget <promptId>');
  return sendToSocket({ command: 'forget', promptId });
}

async function cmdStatus() {
  if (!(await isDaemonAlive())) {
    return { ok: true, data: { connected: false, daemon: 'not-running' } };
  }
  return sendToSocket({ command: 'status' });
}

async function cmdStop() {
  if (!(await isDaemonAlive())) return { ok: true, data: { stopped: false, reason: 'not-running' } };
  return sendToSocket({ command: 'stop' });
}

// --- CLI dispatch ------------------------------------------------------------

function parseFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return null;
}

async function main() {
  const [, , subcommand, ...rest] = process.argv;
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(
      'usage:\n' +
        '  copilot-acp-client.mjs start [--cwd <path>]\n' +
        '  copilot-acp-client.mjs prompt <sessionId> <text...>\n' +
        '  copilot-acp-client.mjs prompt-auto [--cwd <path>] <text...>\n' +
        '  copilot-acp-client.mjs prompt-bg [--session <sid>] [--cwd <path>] <text...>\n' +
        '  copilot-acp-client.mjs watch <promptId> [--since <N>] [--raw] [--wait <sec>] [--summary-only]\n' +
        '  copilot-acp-client.mjs inspect <promptId> [--limit <N>]\n' +
        '  copilot-acp-client.mjs await <promptId> [--max-wait <sec>]\n' +
        '  copilot-acp-client.mjs cancel <promptId>\n' +
        '  copilot-acp-client.mjs forget <promptId>\n' +
        '  copilot-acp-client.mjs status\n' +
        '  copilot-acp-client.mjs stop',
    );
    process.exit(0);
  }

  try {
    let result;
    switch (subcommand) {
      case 'start': result = await cmdStart(rest); break;
      case 'prompt': result = await cmdPrompt(rest); break;
      case 'prompt-auto': result = await cmdPromptAuto(rest); break;
      case 'prompt-bg': result = await cmdPromptBg(rest); break;
      case 'watch': result = await cmdWatch(rest); break;
      case 'inspect': result = await cmdInspect(rest); break;
      case 'await': result = await cmdAwait(rest); break;
      case 'cancel': result = await cmdCancel(rest); break;
      case 'forget': result = await cmdForget(rest); break;
      case 'status': result = await cmdStatus(); break;
      case 'stop': result = await cmdStop(); break;
      default:
        console.error(`unknown subcommand: ${subcommand}`);
        process.exit(1);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    process.exit(1);
  }
}

main();
