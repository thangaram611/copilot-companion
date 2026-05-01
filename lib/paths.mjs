// paths.mjs — single resolver for /tmp artifacts owned by this plugin.
//
// Three artifacts share a per-user namespace so concurrent users on a shared
// host don't collide and can't read each other's prompt I/O:
//
//   socketPath()           → ${TMPDIR}/copilot-acp-<ns>.sock          (daemon, singleton-per-user)
//   queuePath()            → ${TMPDIR}/copilot-completions-<ns>.jsonl (bridge → drain hook)
//   eventsPath(promptId)   → ${TMPDIR}/copilot-acp-<ns>-<promptId>.jsonl (per-prompt, daemon)
//
// The drain hook (POSIX shell) computes the same namespace via `id -u` —
// keep the format below in sync with hooks/drain-completions.sh.
//
// Env overrides: COPILOT_SOCKET_PATH and COPILOT_QUEUE_PATH still win — used
// by tests and by advanced users who want explicit control.

import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

function computeNamespace() {
  // Prefer numeric uid: stable, never contains shell metacharacters, present
  // on every POSIX platform we ship to.
  if (typeof process.getuid === 'function') {
    const uid = process.getuid();
    if (Number.isInteger(uid) && uid >= 0) return `uid${uid}`;
  }
  // Fall back to username on platforms without getuid (Windows). Restrict to
  // a portable charset so the value is safe to interpolate into file paths.
  try {
    const name = userInfo().username;
    if (name && /^[A-Za-z0-9._-]{1,32}$/.test(name)) return `user-${name}`;
  } catch {
    // userInfo() can throw on some restricted environments
  }
  // Last-resort sentinel. Same behaviour as the pre-fix shared `/tmp` paths,
  // but at least the artifacts cluster under one obvious tag.
  return 'shared';
}

const NS = computeNamespace();
const BASE = tmpdir();

export function namespaceTag() {
  return NS;
}

export function socketPath() {
  return process.env.COPILOT_SOCKET_PATH || join(BASE, `copilot-acp-${NS}.sock`);
}

export function queuePath() {
  return process.env.COPILOT_QUEUE_PATH || join(BASE, `copilot-completions-${NS}.jsonl`);
}

// Constrains promptId to the shape randomUUID() produces (the only
// in-tree caller). Any value with separators, dots, or non-UUID characters
// is rejected at the boundary so a future caller passing externally-sourced
// input cannot redirect file writes outside TMPDIR.
const PROMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function eventsPath(promptId) {
  if (typeof promptId !== 'string' || !PROMPT_ID_PATTERN.test(promptId)) {
    throw new TypeError('eventsPath: promptId must be a UUID');
  }
  return join(BASE, `copilot-acp-${NS}-${promptId}.jsonl`);
}

// Permission mode for any file we create that contains prompt content or
// authentication-adjacent state. Owner-only read/write; matches lib/state.mjs.
export const SECURE_FILE_MODE = 0o600;
