#!/usr/bin/env bash
# copilot-companion v0.0.1 — post-install setup
# Idempotent: safe to run multiple times.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok()   { printf "${GREEN}[OK]${NC}   %s\n" "$1"; }
warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
fail() { printf "${RED}[FAIL]${NC} %s\n" "$1"; }

echo "=== copilot-companion v0.0.1 setup (plugin layout) ==="
echo ""
echo "This directory is a Claude Code plugin. Subagent-scoped MCP architecture:"
echo ""
echo "    .claude-plugin/plugin.json       plugin manifest"
echo "    templates/copilot-companion.md   subagent template (with inline mcpServers)"
echo "    hooks/hooks.json                 SessionStart hooks: install-agent + prewarm + deps + drain"
echo ""
echo "On every session, hooks/install-agent.sh materializes the template into"
echo "~/.claude/agents/copilot-companion.md (with \${CLAUDE_PLUGIN_ROOT} substituted)."
echo "Because the agent lives under user scope, its inline mcpServers field is"
echo "honored — main Claude never sees the bridge MCP, only the subagent does."
echo ""
echo "Preferred installation is via /plugin install (see README.md). This script"
echo "is only needed if you want to materialize the agent file before the first"
echo "Claude Code session, e.g. local-dev tinkering."
echo ""

# --- Step 1: Verify prerequisites -------------------------------------------

printf "Checking prerequisites...\n"

if ! command -v node >/dev/null 2>&1; then
  fail "node not found on PATH. Install Node.js >= 20."
  exit 1
fi
NODE_VER=$(node -e "console.log(process.version.slice(1).split('.')[0])")
if [ "$NODE_VER" -lt 20 ] 2>/dev/null; then
  fail "Node.js >= 20 required (found v$NODE_VER)."
  exit 1
fi
ok "node v$(node --version | tr -d 'v')"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found on PATH."
  exit 1
fi
ok "npm $(npm --version)"

if command -v copilot >/dev/null 2>&1; then
  ok "copilot $(copilot --version 2>/dev/null || echo 'found')"
else
  warn "copilot binary not found on PATH. Delegation features will not work until installed."
fi

if command -v claude >/dev/null 2>&1; then
  ok "claude found"
else
  warn "claude (Claude Code CLI) not found. Install from https://claude.ai/code"
fi

echo ""

# --- Step 2: Install node_modules for bridge server -------------------------

printf "Installing bridge server dependencies...\n"
BRIDGE_DIR="$SCRIPT_DIR/bridge-server"
if [ -d "$BRIDGE_DIR" ] && [ -f "$BRIDGE_DIR/package.json" ]; then
  cd "$BRIDGE_DIR" && npm install --silent --no-audit --no-fund
  ok "bridge-server node_modules installed"
else
  fail "bridge-server/package.json not found at $BRIDGE_DIR"
  exit 1
fi

echo ""

# --- Step 3: Verify plugin surface is present -------------------------------
#
# In plugin layout the subagent, MCP, and hooks live inside this directory.
# Claude Code discovers them on plugin enable; this check just confirms the
# files are present before we hand off.

printf "Checking plugin surface...\n"
for path in \
    "$SCRIPT_DIR/.claude-plugin/plugin.json" \
    "$SCRIPT_DIR/templates/copilot-companion.md" \
    "$SCRIPT_DIR/hooks/hooks.json" \
    "$SCRIPT_DIR/hooks/drain-completions.sh" \
    "$SCRIPT_DIR/hooks/install-deps.sh" \
    "$SCRIPT_DIR/hooks/install-agent.sh" \
    "$SCRIPT_DIR/hooks/prewarm-daemon.sh"; do
  if [ -f "$path" ]; then
    ok "$(basename "$path")"
  else
    fail "missing: $path"
    exit 1
  fi
done

# Materialize the subagent now (instead of waiting for first SessionStart) —
# matters when the user wants to invoke /agents in their very first session
# without /reload-plugins. Idempotent.
printf "Materializing subagent at ~/.claude/agents/copilot-companion.md...\n"
CLAUDE_PLUGIN_ROOT="$SCRIPT_DIR" bash "$SCRIPT_DIR/hooks/install-agent.sh"
if [ -f "$HOME/.claude/agents/copilot-companion.md" ]; then
  ok "subagent installed at ~/.claude/agents/copilot-companion.md"
else
  warn "subagent install hook ran but file not found — check $SCRIPT_DIR/hooks/install-agent.sh"
fi

echo ""

# --- Step 4: Copilot-side reviewer agent ------------------------------------

printf "Setting up Copilot reviewer agent...\n"
COPILOT_AGENTS="$HOME/.copilot/agents"
REVIEWER_AGENT="$COPILOT_AGENTS/reviewer.agent.md"
mkdir -p "$COPILOT_AGENTS"
if [ ! -f "$REVIEWER_AGENT" ]; then
  if [ -f "$SCRIPT_DIR/.copilot/agents/reviewer.agent.md" ]; then
    cp "$SCRIPT_DIR/.copilot/agents/reviewer.agent.md" "$REVIEWER_AGENT"
    ok "reviewer.agent.md copied to $COPILOT_AGENTS/"
  else
    warn "reviewer.agent.md source not found, skipping"
  fi
else
  ok "reviewer.agent.md already exists"
fi

echo ""

# --- Step 5: Agent Teams env var --------------------------------------------

printf "Checking Agent Teams configuration...\n"
ZSHRC="$HOME/.zshrc"
if [ -f "$ZSHRC" ] && grep -q 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' "$ZSHRC"; then
  ok "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS already in $ZSHRC"
else
  echo '' >> "$ZSHRC"
  echo '# Claude Code: enable experimental agent teams for multi-agent orchestration' >> "$ZSHRC"
  echo 'export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1' >> "$ZSHRC"
  ok "Added CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to $ZSHRC"
  warn "Run 'source ~/.zshrc' or restart your terminal for this to take effect."
fi

echo ""

# --- Step 6: Syntax-check all .mjs files ------------------------------------

printf "Syntax-checking scripts...\n"
FAIL_COUNT=0
for f in "$SCRIPT_DIR"/bridge-server/*.mjs "$SCRIPT_DIR"/scripts/*.mjs; do
  [ -f "$f" ] || continue
  if node --check "$f" 2>/dev/null; then
    ok "$(basename "$f")"
  else
    fail "$(basename "$f") — syntax error"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

if [ "$FAIL_COUNT" -gt 0 ]; then
  fail "$FAIL_COUNT file(s) have syntax errors"
  exit 1
fi

echo ""

# --- Step 7: Run unit tests -------------------------------------------------

printf "Running unit tests...\n"
if [ -f "$SCRIPT_DIR/lib/prompt-supervisor.test.mjs" ]; then
  if node --test \
       "$SCRIPT_DIR/lib/prompt-supervisor.test.mjs" \
       "$SCRIPT_DIR/lib/prompt-inspect.test.mjs" \
       "$SCRIPT_DIR/lib/state.test.mjs" \
       "$SCRIPT_DIR/lib/log.test.mjs" \
       "$SCRIPT_DIR/bridge-server/validation.test.mjs" \
       "$SCRIPT_DIR/bridge-server/server.test.mjs" 2>/dev/null; then
    ok "unit tests passed"
  else
    warn "unit tests failed (non-blocking)"
  fi
else
  warn "test files not found, skipping"
fi

echo ""

# --- Done -------------------------------------------------------------------

echo "=== Setup complete ==="
echo ""
echo "For local-dev use without plugin install:"
echo ""
echo "  claude --plugin-dir \"$SCRIPT_DIR\""
echo ""
echo "For regular install after this plugin ships:"
echo ""
echo "  /plugin install copilot-companion"
echo ""
echo "Describe what you want in natural language (e.g. \"have copilot audit"
echo "the auth module\") and main Claude will spawn the copilot-companion"
echo "subagent automatically. The bridge is spawned inline per invocation."
