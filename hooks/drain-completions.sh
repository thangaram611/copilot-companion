#!/bin/bash
# drain-completions.sh — surface Copilot completions into Claude's context.
#
# Fires on three hook events (PostToolUse for any tool, UserPromptSubmit,
# SessionStart:startup). Atomic drain pattern: move-then-read, so writes landing
# during the drain get their own next-turn event.
#
# Empty queue → emits nothing → no injection, no context pollution.

set -e

# Per-user namespace — must match lib/paths.mjs::computeNamespace().
# Three-tier fallback identical to the Node side:
#   1. Numeric uid via `id -u` (the same value process.getuid() returns)
#   2. Username via `id -un`, gated by the same regex Node uses
#   3. 'shared' sentinel (last resort)
# A divergence here causes the bridge and the drain hook to read/write
# different files, which silently breaks completion surfacing.
NS=""
if NS_UID=$(id -u 2>/dev/null) && [ -n "$NS_UID" ] && [ "$NS_UID" -ge 0 ] 2>/dev/null; then
  NS="uid${NS_UID}"
elif NS_USER=$(id -un 2>/dev/null) && [ -n "$NS_USER" ] \
     && printf '%s' "$NS_USER" | grep -qE '^[A-Za-z0-9._-]{1,32}$'; then
  NS="user-${NS_USER}"
else
  NS="shared"
fi
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
QUEUE="${COPILOT_QUEUE_PATH:-${TMP_BASE}/copilot-completions-${NS}.jsonl}"

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
