#!/bin/bash
# prewarm-daemon.sh — SessionStart hook
#
# Pre-spawns the copilot-acp-daemon at session start so the first MCP delegation
# call doesn't pay the daemon-spawn latency. Eliminates the lazy-spawn race
# that surfaces as "bridge_daemon_unreachable" when the daemon is cold and the
# bridge's 8s ensureDaemon timeout collides with system load or stale-socket
# cleanup.
#
# Idempotent: ensureDaemon() probes the socket first and only spawns when no
# healthy daemon answers. Non-fatal: any failure here falls back to the bridge's
# lazy ensureDaemon() at first MCP call. Backgrounded with nohup + disown so
# session start never waits on it.
#
# Safe to run before install-deps.sh: daemon-client.mjs and the daemon itself
# only use Node built-ins (node:net, node:fs, node:child_process, etc.) — no
# bare imports — so they don't need bridge-server/node_modules to be present.

ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$ROOT" ] || exit 0

CLIENT="$ROOT/bridge-server/daemon-client.mjs"
[ -f "$CLIENT" ] || exit 0

cd "$ROOT/bridge-server" 2>/dev/null || exit 0

nohup node -e "
import('./daemon-client.mjs')
  .then((m) => m.ensureDaemon({}))
  .catch(() => {});
" >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
