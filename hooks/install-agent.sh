#!/bin/bash
# install-agent.sh — SessionStart hook
#
# Installs the copilot-companion subagent to ~/.claude/agents/copilot-companion.md
# with ${CLAUDE_PLUGIN_ROOT} substituted to its absolute value at install time.
#
# Why we need this: the canonical way to scope an MCP server to a specific
# subagent only (so the parent session never sees it) is the agent's inline
# `mcpServers` frontmatter — but Claude Code silently ignores `mcpServers` /
# `hooks` / `permissionMode` for plugin-shipped agents. The official workaround
# in the docs is to copy the agent into `~/.claude/agents/` (user scope) where
# those fields are honored. This hook automates that copy on every session
# start, idempotently.
#
# After this runs, the standalone agent at ~/.claude/agents/copilot-companion.md
# spawns the bridge MCP server inline ONLY when the subagent is invoked. Main
# Claude has no `mcp__copilot-bridge__copilot` in its tool surface — there is
# no plugin-level .mcp.json registration anywhere.
#
# Idempotent: rewrites the destination only when its checksum changes.
# Sentinel-guarded: leaves alone any user-authored agent file at the same
# path (no auto-generated header → don't touch).
#
# Sentinel placement: must be INSIDE the YAML frontmatter as a `# ...` comment,
# not above the leading `---`. Claude Code's agent discovery requires the file
# to START with `---`; anything before that (HTML comment, blank line) makes
# the parser drop the file from /agents listing. We insert the sentinel as
# line 2, right after the opening `---`.

ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$ROOT" ] || exit 0

TEMPLATE="$ROOT/templates/copilot-companion.md"
[ -f "$TEMPLATE" ] || exit 0

DEST_DIR="$HOME/.claude/agents"
DEST="$DEST_DIR/copilot-companion.md"
SENTINEL="# AUTO-INSTALLED by copilot-companion plugin (hooks/install-agent.sh) — edits will be overwritten on next session"

mkdir -p "$DEST_DIR"

# Don't clobber a hand-edited or differently-sourced agent file. Only proceed
# if the destination either doesn't exist or contains our sentinel.
if [ -f "$DEST" ] && ! grep -qF "$SENTINEL" "$DEST"; then
  exit 0
fi

# Materialize: insert sentinel as a YAML-comment line right after the opening
# `---` of the frontmatter, then substitute ${CLAUDE_PLUGIN_ROOT} in the body.
# awk insertion preserves the file starting with `---` so Claude Code's
# frontmatter parser sees a valid YAML block.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

awk -v sentinel="$SENTINEL" 'NR==1 { print; print sentinel; next } { print }' "$TEMPLATE" \
  | sed "s|\${CLAUDE_PLUGIN_ROOT}|$ROOT|g" \
  > "$TMP"

# Atomic update only if content actually changed (avoids spurious file mtime
# bumps and Claude Code's hot-reload churn on identical writes).
if ! cmp -s "$DEST" "$TMP" 2>/dev/null; then
  mv "$TMP" "$DEST"
  trap - EXIT
fi

exit 0
