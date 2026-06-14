# Copilot Companion Next Steps

Compaction-safe queue for work that is still pending. The runtime hardening,
runtime-adapter boundary, MCP tool-surface split, MCP digest resources, Codex
marketplace packaging, and live host smokes are all merged and verified in
code/commits; only the items below remain.

## Remaining Work

1. MCP resource UX verification.
   - Run Claude-host and Codex-host digest `resources/read` from real companion
     turns (the `resources/*` handlers and `resource_link` blocks already ship —
     see `bridge-server/server.mjs` ~L1553-1561 and L490).
   - Then decide whether `digest_path` can become debug-only. It is currently
     returned unconditionally in send/wait/status results and in the public
     schema (`bridge-server/server.mjs` L447, L544, L623, L651, L880, L1603).

2. Repo-owned release validator.
   - Add a script that builds the Codex marketplace package and installs it into
     an isolated `CODEX_HOME` via `codex plugin marketplace add` + `codex plugin
     add`. Today `setup.sh` only probes `codex plugin add --help`; no automated
     end-to-end install validation exists.

3. Optional: prompt-timeout envelope drill.
   - Only run a full-window drill if we need proof of the 25-minute daemon
     timeout (`PROMPT_TIMEOUT_MS` in `scripts/copilot-acp-daemon.mjs` L70). The
     fast smoke already covered short-wait retry messaging, cancel, and reply.

## Guardrails

- Keep IPC, queues, prompt streams, digests, and logs under the per-host `0700`
  runtime root (`lib/runtime-paths.mjs`); only use shared `/tmp` paths if a
  future need is explicitly justified.
- Keep `parallel` as `"auto"`, `"always"`, or `"never"` (the enum in
  `bridge-server/validation.mjs`).
- Use only currently-supported Copilot model names; the deprecated GPT-5.2
  entries stay removed.
- Treat Copilot ACP as preview: keep defensive capability probing and run the
  Copilot CLI with `--experimental`.
- Treat the Copilot SDK adapter as experimental and opt-in
  (`COPILOT_RUNTIME_ADAPTER=sdk`); keep ACP the default until SDK parity matches
  ACP behavior.
