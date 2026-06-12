# Copilot Companion Next Steps

This file is the compaction-safe queue for work after the runtime hardening and
modern host-surface cleanup pass. Keep it current when starting or completing a
phase so future thread resumes do not depend on chat history.

## Completed Baseline

- Private per-host runtime root added under `~/.{claude,codex}/copilot-companion/runtime/`.
- `parallel` changed to `"auto" | "always" | "never"` with heuristic `/fleet` default.
- MCP validation failures now return structured `isError` tool results.
- Node baseline raised to `>=22`; deprecated GPT-5.2 model entries removed.
- `scripts/doctor.mjs` added for environment diagnostics.

Verified before commit:

```bash
node --test $(find bridge-server lib scripts hooks templates -path '*/node_modules' -prune -o -type f -name '*.test.mjs' -print)
while IFS= read -r f; do node --check "$f" >/dev/null || exit 1; done < <(find bridge-server lib scripts hooks templates -path '*/node_modules' -prune -o -type f -name '*.mjs' -print)
node scripts/doctor.mjs --json
npm audit --omit=dev --json
claude plugin validate .
```

## Next Phase Queue

1. Copilot runtime adapter
   - Done in `5172d2f`: add a small runtime interface for `send`, `wait`, `status`, `reply`, and `cancel`.
   - Done in `5172d2f`: keep the current ACP daemon as the default adapter.
   - Done in current SDK phase: add `COPILOT_RUNTIME_ADAPTER=sdk` behind an explicit opt-in flag.
   - Current SDK behavior: preserve the existing reply contract with cancel-and-restart; native SDK `mode:"immediate"` steering is a later API/UI decision.
   - Current SDK behavior: in-flight SDK prompts are explicitly non-resumable after bridge restart; ACP remains the restart-resumable default.
   - Direct bridge smoke passed for both `acp` and `sdk` with `gpt-5-mini`: `send` -> `wait` completed, digest path generated, verbose `status` inspected.
   - SDK smoke findings: `gpt-4.1` was not available in this local SDK account/runtime, and model-specific reasoning effort must stay opt-in.
   - Decision after live-smoke phase: keep ACP as default. Claude-host and Codex-host smokes now pass on ACP; SDK remains opt-in until we intentionally run the same full host-smoke matrix against `COPILOT_RUNTIME_ADAPTER=sdk`.

2. MCP resource polish
   - Done in current MCP resource phase: expose digest files through MCP `resources/list`, `resources/templates/list`, `resources/read`, and tool-result `resource_link` blocks.
   - File paths intentionally remain in responses until both Claude and Codex resource UX is verified.
   - Next: run full Claude-host and Codex-host resource reads from real companion turns, then decide whether digest paths can become debug-only.

3. MCP tool-surface split
   - Done in current tool-split phase: replaced the public multiplexed `copilot` tool with separate tools:
     `copilot_send`, `copilot_wait`, `copilot_status`, `copilot_reply`, `copilot_cancel`.
   - The server still uses the action-based dispatcher internally; the public MCP layer injects the action from the tool name.
   - Done in current live-smoke phase: verified Claude direct companion `status` and `send` with the split MCP tools and no permission denials.
   - Done in current live-smoke phase: verified Codex `spawn_agent` registration for `copilot-companion`; `status` and `send` both reached the split MCP tools.
   - Fixes from live smoke:
     - Claude permission installer now removes the legacy multiplexed `mcp__copilot-bridge__copilot` permission and adds the five split MCP permissions plus the exact required `Bash(echo "$CLAUDE_CODE_SESSION_ID")` probe permission.
     - Codex source-checkout hook installer now migrates legacy untagged hook entries, sets `COPILOT_COMPANION_HOST=codex`, bakes `COPILOT_COMPANION_NODE`, and filters transient `.codex/tmp` PATH segments.
     - Claude and Codex companion templates now define an explicit global `status` render envelope so agents do not emit `undefined` for valid status JSON.

4. Published packaging
   - Done in current packaging phase: Codex manifest now carries marketplace UI metadata and plugin-scoped hooks via `hooks/hooks-codex.json`.
   - Done in current packaging phase: `scripts/build-codex-marketplace.mjs` materializes the Codex-required marketplace root with `./plugins/copilot-companion`.
   - Source-checkout Codex setup still uses `scripts/install-codex-hooks.mjs` to merge dev hooks into `~/.codex/hooks.json`; published Codex packages no longer need that mutation.
   - Verified in current packaging phase: generated Codex marketplace package installs with isolated `CODEX_HOME` on `codex-cli 0.139.0`; Claude marketplace validation also passes with `defaultEnabled: false`.

5. Live end-to-end smoke
   - Done in current live-smoke phase using disposable repo `/tmp/copilot-companion-smoke.nw9Bth`.
   - Claude direct companion smoke:
     - `status` succeeded with no permission denials after permission migration.
     - `send` completed as job `copilot-mqasb28d-u4hs`.
     - Digest: `~/.claude/copilot-companion/runtime/digests/copilot-digest-copilot-mqasb28d-u4hs.md`.
     - Runtime dir and digest dir were `0700`; digest file was `0600`.
   - Codex host smoke through real `codex exec` + `spawn_agent`:
     - `status` succeeded after template status-envelope fix.
     - `send` completed as job `copilot-mqasidqx-caej`.
     - Digest: `~/.codex/copilot-companion/runtime/digests/copilot-digest-copilot-mqasidqx-caej.md`.
     - Runtime dir and digest dir were `0700`; digest file was `0600`.
   - Control-path smoke through the live Codex-routed bridge dispatcher:
     - Short `wait` on job `copilot-mqasmykx-nfqn` returned `still_running` with a digest path and retry hint.
     - `cancel` on job `copilot-mqasmykx-nfqn` returned `cancelled:true`; terminal wait reported `status:"cancelled"`.
     - `reply` on job `copilot-mqasnd3z-yvay` returned a replacement prompt id and terminal wait completed with `REPLY_SMOKE_OK`.
   - Disposable repo remained clean after all smokes.

## Current Status

- Core delegation, host registration, source-checkout install, published Codex packaging, live send, digest, wait, cancel, and reply paths are verified.
- Remaining polish before publishing:
  - MCP resource UX verification: run Claude-host and Codex-host resource reads from real companion turns, then decide whether digest paths can become debug-only.
  - Add a repo-owned release validator that builds the Codex marketplace package and installs it into an isolated `CODEX_HOME` with `codex plugin marketplace add` + `codex plugin add`.
  - Consider a slower manual prompt-timeout drill only if we need proof of the 25-minute daemon timeout envelope; the fast live smoke verified short wait retry messaging, cancel, and reply without burning a full prompt-timeout window.

## Guardrails

- Do not reintroduce shared `/tmp` defaults for IPC, queues, prompt streams, digests, or logs.
- Do not restore boolean `parallel`; use only `"auto"`, `"always"`, or `"never"`.
- Do not pin deprecated GPT-5.2 model names.
- Treat Copilot ACP as preview; keep defensive capability probing.
- Treat Copilot SDK as experimental until live behavior matches the ACP adapter.
