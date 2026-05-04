// paths.mjs — runtime path resolver for copilot-companion's IPC artifacts.
//
// All artifacts live inside ONE per-user directory at mode 0o700:
//
//   <base>/copilot-companion-<ns>/
//     ├── daemon.sock
//     ├── completions.jsonl
//     └── events-<promptId>.jsonl
//
// The directory's permissions ARE the security guarantee — once created
// 0o700-owned-by-us, no other local uid can pre-bind a socket, pre-create
// a queue file, or plant a symlink at any of the artifact paths inside.
// This shape replaces the per-file-with-namespace-suffix layout that
// upstream PR review correctly flagged as still attackable.
//
// Resolution of <base>:
//   1. COPILOT_RUNTIME_BASE         — explicit override (tests, operators)
//   2. XDG_RUNTIME_DIR (uid > 0)    — freedesktop spec, Linux-desktop standard
//                                     (typically /run/user/<uid> mode 0o700)
//   3. os.tmpdir()                  — fallback (already mode 0o700 on macOS)
//
// The drain hook (hooks/drain-completions.sh) computes the same <base> via
// shell — keep the resolution logic in sync.

import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, lstatSync } from 'node:fs';

// ───── namespace (per-user identity used in dir name) ─────

function computeNamespace() {
  // Prefer numeric uid: stable, no shell metacharacters, present on every
  // POSIX platform we ship to.
  if (typeof process.getuid === 'function') {
    const uid = process.getuid();
    if (Number.isInteger(uid) && uid >= 0) return `uid${uid}`;
  }
  // Fall back to username on platforms without getuid (Windows). 64-char
  // cap accommodates LDAP/AD environments where UPNs and prefixed names
  // can exceed the POSIX 32 — falling back to 'shared' for such users
  // would silently collapse them all into one runtime dir.
  try {
    const name = userInfo().username;
    if (name && /^[A-Za-z0-9._-]{1,64}$/.test(name)) return `user-${name}`;
  } catch {
    // userInfo() can throw on some restricted environments
  }
  return 'shared';
}

// Read an env var override but treat empty strings as unset. Without this,
// `process.env.X || default` would silently pick the default when a caller
// (test harness, CI) accidentally exports `X=''`, masking the misconfiguration
// behind production behaviour. Returns null when the var is unset OR empty.
function envOverride(name) {
  const v = process.env[name];
  return (v && v.length > 0) ? v : null;
}

const NS = computeNamespace();

// ───── runtime directory path ─────

function _runtimeDirBase() {
  const override = envOverride('COPILOT_RUNTIME_BASE');
  if (override) return override;
  // XDG_RUNTIME_DIR: Linux-desktop standard. Skip for root since root
  // sessions typically don't have it set and its lifecycle is tied to a
  // user login session.
  const xdg = envOverride('XDG_RUNTIME_DIR');
  if (xdg && typeof process.getuid === 'function' && process.getuid() > 0) {
    return xdg;
  }
  return tmpdir();
}

export function runtimeDirPath() {
  return join(_runtimeDirBase(), `copilot-companion-${NS}`);
}

// ───── ensureRuntimeDir — the security guarantee ─────

/**
 * Ensure the per-user runtime directory exists, is owned by us, and is
 * mode 0o700 — unwritable by other local users.
 *
 * Callers MUST invoke this before any operation that creates or opens a
 * file inside the directory: socket bind, file write, AND socket connect
 * (the parent dir is the security boundary, so connecting blindly to a
 * pre-bound rogue socket inside an unverified dir is what the upstream
 * reviewer flagged as P1 attack #1).
 *
 * Idempotent: cheap to call from many sites. Uses mkdir(recursive) +
 * lstat verification. The verification is what makes the function secure,
 * since mkdir({recursive:true}) silently succeeds on a pre-existing dir
 * WITHOUT changing its permissions or owner.
 *
 * Errors are intentionally fatal — auto-chmod or auto-chown of a dir we
 * don't fully control opens new TOCTOU windows. Failure means the user
 * must manually inspect and remediate.
 *
 * @returns {string} The verified absolute path of the runtime directory.
 * @throws {Error}   If creation fails or any verification invariant fails.
 */
export function ensureRuntimeDir() {
  const dir = runtimeDirPath();

  // Windows: no POSIX uid/mode. Security model is NTFS-ACL-based and out
  // of scope for this function. We still verify the path is a directory
  // (not a symlink-to-dir or a regular file) so an attacker can't redirect
  // creates by planting a symlink — same invariant 1 as the POSIX path.
  if (typeof process.getuid !== 'function') {
    mkdirSync(dir, { recursive: true });
    const st = lstatSync(dir);
    if (!st.isDirectory()) {
      throw new Error(
        `ensureRuntimeDir: ${dir} is not a directory ` +
        `(symlink or regular file). Manually inspect and remove.`
      );
    }
    return dir;
  }

  // POSIX verify-or-throw. mkdir is best-effort; the lstat+invariant
  // checks below are what actually enforce the security boundary. Each
  // throw includes (a) the offending path, (b) the observed value that
  // failed, (c) an actionable remediation. These errors fire when the
  // host is misconfigured or under attack — a vague error here is a
  // 30-minute support call.

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);

  // Invariant 1: must be a real directory. lstat does NOT follow
  // symlinks, so a symlink-to-dir planted by an attacker shows up here
  // as S_IFLNK and isDirectory() returns false.
  if (!st.isDirectory()) {
    throw new Error(
      `ensureRuntimeDir: ${dir} is not a directory ` +
      `(found a symlink or regular file). An attacker may have planted ` +
      `this path. Manually inspect and remove it: rm -f ${dir}`
    );
  }

  // Invariant 2: must be owned by us. mkdirSync({recursive:true})
  // silently succeeds against an existing dir without changing its
  // owner, so this check cannot be skipped.
  if (st.uid !== process.getuid()) {
    throw new Error(
      `ensureRuntimeDir: ${dir} is owned by uid ${st.uid}, ` +
      `expected uid ${process.getuid()}. This indicates a stale dir ` +
      `from another user or a pre-creation attack. ` +
      `Remove and retry: rm -rf ${dir}`
    );
  }

  // Invariant 3: no group/world access bits, regardless of how the dir
  // got here. Catches the case where a prior buggy run (or tampering)
  // left mode 0o755 on a dir we still own.
  if ((st.mode & 0o077) !== 0) {
    const observed = (st.mode & 0o777).toString(8).padStart(3, '0');
    throw new Error(
      `ensureRuntimeDir: ${dir} has mode 0o${observed}, expected 0o700 ` +
      `(owner-only). Group or world access bits would let other local ` +
      `users read prompt content. ` +
      `Fix: chmod 700 ${dir}, or remove and retry: rm -rf ${dir}`
    );
  }

  return dir;
}

// ───── artifact paths (pure getters, no side effects) ─────
//
// These return strings; they DO NOT mkdir or verify. Callers that intend
// to write to these paths must call ensureRuntimeDir() first to establish
// the security boundary on the parent directory.
//
// Env overrides (COPILOT_SOCKET_PATH, COPILOT_QUEUE_PATH) bypass the
// runtime dir entirely. Reserved for tests and advanced users — they
// opt out of the security model knowingly.

export function socketPath() {
  return envOverride('COPILOT_SOCKET_PATH')
    || join(runtimeDirPath(), 'daemon.sock');
}

export function queuePath() {
  return envOverride('COPILOT_QUEUE_PATH')
    || join(runtimeDirPath(), 'completions.jsonl');
}

// The daemon's diagnostic log. Lives inside the runtime dir so it inherits
// the 0o700 security boundary; previously it was at /tmp/copilot-acp-daemon.log
// (un-namespaced, world-readable) which contradicted the security claim of
// the runtime-dir migration.
export function daemonLogPath() {
  return join(runtimeDirPath(), 'daemon.log');
}

const PROMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function eventsPath(promptId) {
  if (typeof promptId !== 'string' || !PROMPT_ID_PATTERN.test(promptId)) {
    throw new TypeError('eventsPath: promptId must be a UUID');
  }
  return join(runtimeDirPath(), `events-${promptId}.jsonl`);
}

export function namespaceTag() {
  return NS;
}

// Permission mode for any file we create that contains prompt content
// or authentication-adjacent state. Owner-only read/write; matches
// lib/state.mjs.
export const SECURE_FILE_MODE = 0o600;
