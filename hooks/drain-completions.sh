#!/bin/bash
# drain-completions.sh — surface Copilot completions into Claude's context.
#
# Fires on three hook events (PostToolUse for any tool, UserPromptSubmit,
# SessionStart:startup). Atomic drain pattern: move-then-read, so writes landing
# during the drain get their own next-turn event.
#
# Empty queue → emits nothing → no injection, no context pollution.

set -e

# validate_env_value — mirrors lib/paths.mjs::envOverride()
# Returns the trimmed value if it's a valid override, empty otherwise.
# Rejects unset/empty, values containing \r/\n/\t, and whitespace-only.
# Trims leading/trailing whitespace from accepted values.
# Stays in sync with the Node side; without this, the bridge writes to
# one runtime dir while the hook drains another, silently dropping
# completion surfacing.
validate_env_value() {
  local v="$1"
  [ -z "$v" ] && return 0
  case "$v" in
    *$'\r'*|*$'\n'*|*$'\t'*) return 0 ;;
  esac
  # Trim leading whitespace
  v="${v#"${v%%[![:space:]]*}"}"
  # Trim trailing whitespace
  v="${v%"${v##*[![:space:]]}"}"
  [ -n "$v" ] && printf '%s' "$v"
  # CRITICAL: must return 0 unconditionally. The hook runs under set -e,
  # and command substitutions like `X=$(validate_env_value "$Y")` propagate
  # the function's exit code. If $v is empty/whitespace-only, the
  # `[ -n "$v" ]` test above returns 1, which would abort the entire hook
  # before reaching the fallback resolver. Rejection is signaled by empty
  # OUTPUT, never by exit code.
  return 0
}

# Per-user namespace — must match lib/paths.mjs::computeNamespace().
# Three-tier fallback identical to the Node side:
#   1. Numeric uid via `id -u` (the same value process.getuid() returns)
#   2. Username via `id -un`, gated by the same 64-char regex Node uses
#   3. 'shared' sentinel (last resort)
# Username cap is 64 chars (matches lib/paths.mjs after commit 213af04).
# Earlier 32-char cap silently collapsed LDAP/AD users into 'shared'.
NS=""
if NS_UID=$(id -u 2>/dev/null) && [ -n "$NS_UID" ] && [ "$NS_UID" -ge 0 ] 2>/dev/null; then
  NS="uid${NS_UID}"
elif NS_USER=$(id -un 2>/dev/null) && [ -n "$NS_USER" ] \
     && printf '%s' "$NS_USER" | grep -qE '^[A-Za-z0-9._-]{1,64}$'; then
  NS="user-${NS_USER}"
else
  NS="shared"
fi

# Runtime base — must match _runtimeDirBase() in lib/paths.mjs.
# Resolution order: COPILOT_RUNTIME_BASE → XDG_RUNTIME_DIR (uid > 0) → TMPDIR/tmp.
# Both env vars go through validate_env_value() so empty/whitespace/control-
# char values fall through to the next tier — matching Node's behaviour.
COPILOT_RUNTIME_BASE_VALID="$(validate_env_value "${COPILOT_RUNTIME_BASE:-}")"
XDG_RUNTIME_DIR_VALID="$(validate_env_value "${XDG_RUNTIME_DIR:-}")"
if [ -n "$COPILOT_RUNTIME_BASE_VALID" ]; then
  BASE="$COPILOT_RUNTIME_BASE_VALID"
elif [ -n "$XDG_RUNTIME_DIR_VALID" ] && [ "${NS_UID:-0}" -gt 0 ] 2>/dev/null; then
  BASE="$XDG_RUNTIME_DIR_VALID"
else
  BASE="${TMPDIR:-/tmp}"
fi
BASE="${BASE%/}"

# The runtime dir is created and verified by the daemon (Node side).
# This script DOES NOT create or verify it — if the daemon never ran,
# the queue file won't exist and the `[ -s "$QUEUE" ]` check below
# exits 0 cleanly. Re-creating the dir here would introduce a TOCTOU
# (chmod 700 after mkdir is racy in shell).
#
# Queue path: COPILOT_QUEUE_PATH wins if set, but goes through
# validate_env_value() so empty/whitespace/control-char values fall
# through to the computed runtime queue — matches Node's queuePath()
# behaviour. The third env override that needs the same treatment as
# COPILOT_RUNTIME_BASE and XDG_RUNTIME_DIR; missing it would let
# `COPILOT_QUEUE_PATH=' /tmp/q.jsonl '` (whitespace) or
# `COPILOT_QUEUE_PATH=$'/tmp/q.jsonl\n'` (newline) silently route the
# drain to a different file than the bridge writes to.
COPILOT_QUEUE_PATH_VALID="$(validate_env_value "${COPILOT_QUEUE_PATH:-}")"
if [ -n "$COPILOT_QUEUE_PATH_VALID" ]; then
  QUEUE="$COPILOT_QUEUE_PATH_VALID"
else
  QUEUE="${BASE}/copilot-companion-${NS}/completions.jsonl"
fi

# Read stdin payload so we can echo the firing event's name back in the
# response. Claude Code drops additionalContext when hookEventName doesn't
# match the actual event, so hardcoding one value broke UserPromptSubmit and
# SessionStart drains while silently "working" for PostToolUse.
PAYLOAD=$(cat)
HOOK_EVENT=$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // "PostToolUse"')

# Fast path: no queue file, or empty file → no-op silently.
[ -s "$QUEUE" ] || exit 0

# Atomic drain. $$ prevents collision if multiple hooks fire concurrently.
DRAIN="${QUEUE}.drain.$$"
mv "$QUEUE" "$DRAIN" 2>/dev/null || exit 0
[ -s "$DRAIN" ] || { rm -f "$DRAIN"; exit 0; }

# Build one markdown block per entry. Front-load job_id, status, kind so the
# most critical info survives the 2KB preview fallback if total exceeds 10 KB.
# jq -rs reads the whole JSONL into an array.
# v6.1: filter out entries with .consumed == true — those have already been
# delivered to the subagent via the wait-terminal MCP response.
CONTENT=$(jq -rs '
  map(select(.consumed != true)) |
  map(
    "## Copilot `\(.jobId // "?")` — **\(.meta.status // .kind // "unknown")**\n\n" +
    (.content // "")
  ) | join("\n\n---\n\n")
' < "$DRAIN")

rm -f "$DRAIN"

# v6.1: all entries in this drain were already consumed → nothing to inject.
if [ -z "$CONTENT" ]; then exit 0; fi

jq -n --arg ctx "$CONTENT" --arg evt "$HOOK_EVENT" '{
  hookSpecificOutput: {
    hookEventName: $evt,
    additionalContext: $ctx
  }
}'
exit 0
