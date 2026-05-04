# Copilot Companion

GitHub Copilot delegation for Claude Code, v0.0.1 — **Claude Code plugin with subagent-isolated architecture**.

The entire public surface is a single Claude Code subagent shipped inside this
plugin. Main Claude has **zero** direct MCP visibility into copilot-bridge; the
MCP server is registered at plugin scope and only the subagent declares it in
its `tools:` list. There is no slash command, no user-scope MCP registration,
no main-session hooks, no skill, no session opt-in, no pause, no fleet mode.

## Architecture at a glance

```
copilot-companion/                            ← plugin root
├── .claude-plugin/
│   └── plugin.json                           plugin manifest
├── agents/
│   └── copilot-companion.md                  subagent definition
├── .mcp.json                                 copilot-bridge MCP server
├── hooks/
│   ├── hooks.json                            SessionStart + PostToolUse + UserPromptSubmit
│   ├── drain-completions.sh                  surfaces orphan Copilot completions
│   └── install-deps.sh                       installs bridge-server node_modules to ${CLAUDE_PLUGIN_DATA}
├── bridge-server/
│   ├── server.mjs                            `copilot` MCP tool, 5 actions:
│   │                                         send | wait | status | reply | cancel
│   ├── validation.mjs                        per-action field allow-lists, schemas
│   └── package.json                          runtime deps (MCP SDK)
├── lib/                                      state + logging + prompt utilities
│   ├── state.mjs                             default-model + threads/ state layer
│   ├── log.mjs                               structured logging helper
│   ├── prompt-supervisor.mjs                 wraps Copilot prompts (rubber-duck, etc.)
│   └── prompt-inspect.mjs                    diagnostic dump for a Copilot prompt
├── scripts/                                  daemon + client
│   ├── copilot-acp-daemon.mjs                long-lived Copilot parent process
│   └── copilot-acp-client.mjs                daemon stop/status CLI
├── setup.sh                                  local-dev bootstrap (optional)
├── default-model                             optional; 1-line model id
└── threads/<name>.sid                        persisted Copilot session ids
```

## Installation

`claude plugin install` only accepts plugins registered in a marketplace — there
is no `--plugin-dir` flag on the install subcommand. For persistent local
installs we ship a small `marketplace.json` alongside `plugin.json`, so adding
this directory registers a one-plugin dev marketplace that you can install from.

### Persistent install from this directory

```bash
# Register the local directory as a marketplace (one-time)
claude plugin marketplace add /path/to/copilot-companion

# Install the plugin from that marketplace
claude plugin install copilot-companion@copilot-companion-dev
```

Claude Code copies the plugin to `~/.claude/plugins/cache/`. On the first
session after install, the `SessionStart` hook runs `hooks/install-deps.sh`,
which installs the bridge-server's `node_modules` to
`${CLAUDE_PLUGIN_DATA}/bridge-server/` (persistent across plugin updates) and
symlinks it into `${CLAUDE_PLUGIN_ROOT}/bridge-server/node_modules` so Node's
ESM resolver finds `@modelcontextprotocol/sdk` via ancestor-directory walk.

To pick up changes you make to this directory, bump `version` in
`.claude-plugin/plugin.json`, then:

```bash
claude plugin marketplace update copilot-companion-dev
claude plugin update copilot-companion@copilot-companion-dev
```

### Session-scoped (no install, fastest iteration)

```bash
claude --plugin-dir /path/to/copilot-companion
```

Loads the plugin for one session directly from source — no marketplace, no
cache. Note that `${CLAUDE_PLUGIN_DATA}` is not created for `--plugin-dir`
runs; `install-deps.sh` falls back to `${CLAUDE_PLUGIN_ROOT}/.plugin-data/`
so ESM resolution still works. Alternatively run `bash setup.sh` once to
install deps directly into `bridge-server/node_modules/`.

### Via a published marketplace (end users)

Once submitted and approved:

```
/plugin marketplace add <marketplace-source>
/plugin install copilot-companion@<marketplace-name>
```

## Prerequisites

- **Node.js ≥ 20**
- **GitHub Copilot CLI authenticated.** Install (`npm i -g @github/copilot`), then run `copilot` once interactively to complete GitHub OAuth. The daemon resolves the binary in order: `$COPILOT_BIN` → `command -v copilot` → `/opt/homebrew/bin/copilot`. On Linux, export the absolute path explicitly:
  ```bash
  export COPILOT_BIN=$(command -v copilot)
  ```
- **Agent Teams env var** — `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the shell (required for SendMessage-based thread continuity).

## Permissions (user setup)

The subagent invokes one MCP tool, `mcp__copilot-bridge__copilot`. Without an explicit allow rule, the first invocation in a session can surface a permission prompt — even with `defaultMode: "auto"`. Plugin-level `settings.json` cannot declare permissions (Claude Code honors only `agent` and `subagentStatusLine` there), so the entry must live in your user or project settings.

**Pick whichever fits your install path:**

### A. Source checkout (cloned repo, or running `--plugin-dir`)

Run once from the repo root:

```bash
node scripts/install-permissions.mjs --yes
```

`setup.sh` already runs this as Step 5; the standalone command exists so you can re-run or pre-empt without re-running the full setup. The script is idempotent, takes a timestamped backup of `~/.claude/settings.json` before writing, and preserves the existing order of your allow list.

### B. Marketplace install (`/plugin install copilot-companion@…`)

The plugin source lives under `~/.claude/plugins/cache/<hash>/...`, which isn't a stable path to hand-type. Use either:

1. **Click "Yes, don't ask again"** on the first permission prompt — Claude Code writes the entry to `~/.claude/settings.json` for you. One-time only.
2. **Pre-populate `~/.claude/settings.json`** before your first session:
   ```json
   {
     "permissions": {
       "allow": [
         "mcp__copilot-bridge__copilot"
       ]
     }
   }
   ```
   Or use `/permissions` inside Claude Code to add the rule via UI.

### Optional log-tailing diagnostics

Only useful if you want to inspect the bridge or daemon logs without prompts:

```json
{
  "permissions": {
    "allow": [
      "Bash(tail:*)",
      "Bash(ps:*)",
      "Read(//tmp/**)"
    ]
  }
}
```

> **Note on glob syntax**: `Read(//tmp/**)` uses a **double slash** because Claude Code treats `/x` as project-relative and `//x` as an absolute path. `Read(/tmp/**)` would silently fail to match. See the [permissions docs](https://code.claude.com/docs/en/permissions) for the full path-prefix rules.

### Project-scope alternative

Drop the same JSON into `.claude/settings.local.json` per repo if you'd rather only allow Copilot in specific projects (the file is gitignored by default and not checked in).

## Public surface

You don't call the MCP tool directly. Main Claude reads the subagent's
`description` and spawns it via `Agent()` when the user asks for Copilot
delegation, status checks, replies, or cancellation.

### Internal MCP surface (subagent-only)

```
copilot({ action: "send",   task, mode?, template?, template_args?, cwd?, thread?, max_wait_sec? })
copilot({ action: "wait",   job_id, max_wait_sec? })
copilot({ action: "status", job_id?, verbose? })
copilot({ action: "reply",  job_id, message })
copilot({ action: "cancel", job_id })
```

`send` blocks up to `max_wait_sec` (default 480, max 540). If the job hasn't
terminated, the bridge returns `status: "still_running"` and the subagent
loops on `wait` — emitting one short line between iterations to keep Claude
Code's 600s stream-idle watchdog from firing.

## Thread continuity

Multi-turn Copilot conversations are preserved via subagent resume, not via
main's state:

1. First send: the subagent calls the bridge with no `thread`. The bridge auto-generates `companion-<jobId>` and returns it in the response.
2. The subagent emits `MY_THREAD=<value>` as a visible line in its turn, so the handle is preserved in its conversation history.
3. On follow-up `SendMessage` from main, the subagent auto-resumes with its full prior context, reads `MY_THREAD=` from its own history, and passes it back to the bridge — Copilot resumes the same ACP session.
4. Main's context only carries the opaque `<agentId>`; it never sees or carries the thread name.

### SendMessage invocation form (important)

`SendMessage` validates its `message` param as a tagged union of *(a)* plain-text string or *(b)* a protocol object with `type ∈ {shutdown_request, shutdown_response, plan_approval_response}`. A raw `{"action":"send",...}` object matches neither and fails with `InputValidationError: path ["message"]` ("expected string" on one branch, "no matching discriminator" on the other). Always pass the payload as a **JSON-encoded string**, and always include a `summary`:

```js
// correct — message is a STRING
SendMessage({
  to:      <stored agentId>,
  summary: "follow-up task to copilot",      // 5-10 words, required
  message: '{"action":"send","task":"..."}'  // JSON-encoded string
})

// wrong — message is a raw object, fails schema validation
SendMessage({ to: <id>, message: {"action": "send", "task": "..."} })
```

The same rule applies to the Agent-spawn `prompt` field: pass the JSON payload as a string.

## Design invariants

1. **Strict isolation.** The `copilot-bridge` MCP server is bundled with the plugin but the subagent's `tools:` list is the only path through which it's invoked. Main never calls the bridge directly.
2. **No activation lifecycle.** The bridge is spawned per subagent invocation by Claude Code's plugin MCP machinery. There's nothing to `start`, `stop`, or `pause`.
3. **Bounded blocking.** `send` / `wait` always return within `max_wait_sec ≤ 540` so the MCP transport never hits the 600s idle cap.
4. **Orphan safety net.** Completion events are appended to `/tmp/copilot-completions.jsonl` with `consumed:false`; wait-terminal responses flip to `consumed:true`; the drain hook surfaces only unconsumed entries.
5. **Rubber-duck always on.** Appended to every `send` server-side for every template except `plan_review` (which has its own critique instructions baked in). Not in the schema.
6. **Model is config.** Read from `default-model` at worker start. Never a tool parameter.
7. **Node deps persist, code doesn't.** `bridge-server/node_modules` lives under `${CLAUDE_PLUGIN_DATA}` and survives plugin updates; bundled code under `${CLAUDE_PLUGIN_ROOT}` is re-copied on update.

## Subagent tool surface

The subagent declares these tools (full list in this plugin's `agents/copilot-companion.md` frontmatter):

```
mcp__copilot-bridge__copilot, Bash, Read, Write, Edit, Grep, Glob, WebFetch, TodoWrite
```

`mcp__copilot-bridge__copilot` is the canonical dispatch tool. All others exist for diagnostics, artifact handling, and self-sufficiency. See the frontmatter "Tool surface" and "Forbidden" sections for when each is appropriate.

## Development

- `node --check` should pass on every `.mjs` after edits.
- Tests: `node --test bridge-server/validation.test.mjs bridge-server/server.test.mjs lib/state.test.mjs lib/log.test.mjs lib/prompt-inspect.test.mjs lib/prompt-supervisor.test.mjs`
- Validate the plugin manifest: `claude plugin validate` from the plugin root.

## Out of scope

- Main Claude speaking to the bridge directly.
- Skill file / slash commands (gone in v6.1).
- Session opt-in, pause, fleet mode (all removed).
- MCP elicitation (`NEEDS_USER_INPUT:` flow) — deferred to a future version.
