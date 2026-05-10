#!/bin/bash
# install-agent-codex.sh — Codex SessionStart hook
#
# Materializes templates/copilot-companion.toml to ~/.codex/agents/copilot-companion.toml
# with ${CLAUDE_PLUGIN_ROOT} substituted to its absolute value at install time.
#
# Why we need this: Codex's `RawPluginManifest` has NO `agents` field — Codex
# loads subagents only from ~/.codex/agents/ (and per-project .codex/agents/).
# So plugin-bundled subagents must be materialized at install time, then
# kept fresh on every SessionStart in case the plugin upgraded.
#
# This script is the Codex sibling of hooks/install-agent.sh. The Codex
# version differs in three ways:
#   1. Output format is .toml (not .md with YAML frontmatter).
#   2. Sentinel placement: just a `# comment` line at the very top of the
#      file. TOML parsers ignore lines starting with `#`. Unlike the Claude
#      version we don't need to thread it INTO a frontmatter block — TOML
#      has no frontmatter / no required leading delimiter, so a comment on
#      line 1 is fine.
#   3. ${CLAUDE_PLUGIN_ROOT} substitution happens here too — Codex MCP
#      `args` strings are LITERALS at runtime (no `${VAR}` expansion), so
#      the only chance we get to bake the absolute path into the agent's
#      MCP server config is at materialization time.
#
# Idempotent: rewrites the destination only when its checksum changes.
# Sentinel-guarded: leaves alone any user-authored agent file at the same
# path (no auto-generated header → don't touch).

ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$ROOT" ] || exit 0

TEMPLATE="$ROOT/templates/copilot-companion.toml"
[ -f "$TEMPLATE" ] || exit 0

DEST_DIR="$HOME/.codex/agents"
DEST="$DEST_DIR/copilot-companion.toml"
SENTINEL="# AUTO-INSTALLED by copilot-companion plugin (hooks/install-agent-codex.sh) — edits will be overwritten on next session"

mkdir -p "$DEST_DIR"

# Don't clobber a hand-edited or differently-sourced agent file. Only proceed
# if the destination either doesn't exist or contains our sentinel.
if [ -f "$DEST" ] && ! grep -qF "$SENTINEL" "$DEST"; then
  exit 0
fi

# Materialize: prepend the sentinel as line 1, then substitute
# ${CLAUDE_PLUGIN_ROOT} in the body. The substitution targets the literal
# token inside `mcp_servers.copilot-bridge.args` so the bridge launcher gets
# an absolute path at runtime.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  printf '%s\n' "$SENTINEL"
  sed "s|\${CLAUDE_PLUGIN_ROOT}|$ROOT|g" "$TEMPLATE"
} > "$TMP"

# Atomic update only if content actually changed (avoids spurious file mtime
# bumps on identical writes).
if ! cmp -s "$DEST" "$TMP" 2>/dev/null; then
  mv "$TMP" "$DEST"
  trap - EXIT
fi

exit 0
