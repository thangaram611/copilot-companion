// Environment diagnostics shared by the CLI doctor and MCP status surface.

import { execFileSync } from 'node:child_process';

import {
  bridgeLogFile,
  daemonLogFile,
  daemonSocketPath,
  digestDir,
  promptJsonlDir,
  queuePath,
  runtimeDir,
} from './runtime-paths.mjs';

function runCommand(cmd, args = []) {
  try {
    return {
      ok: true,
      output: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    };
  } catch (err) {
    return {
      ok: false,
      output: String(err.stderr || err.message || '').trim(),
    };
  }
}

function commandVersion(cmd, args = ['--version'], run = runCommand) {
  const result = run(cmd, args);
  return { found: result.ok, version: result.ok ? result.output.split('\n')[0] : null };
}

function nodeInfo(nodeVersion = process.versions.node) {
  const cleanVersion = String(nodeVersion || '').replace(/^v/, '');
  const major = Number(cleanVersion.split('.')[0]);
  return {
    found: true,
    version: `v${cleanVersion}`,
    ok: major >= 22,
    required: '>=22',
  };
}

function codexInfo(run = runCommand) {
  const version = commandVersion('codex', ['--version'], run);
  if (!version.found) return { ...version, pluginAdd: false };
  return {
    ...version,
    pluginAdd: run('codex', ['plugin', 'add', '--help']).ok,
    marketplaceAdd: run('codex', ['plugin', 'marketplace', 'add', '--help']).ok,
  };
}

export function buildDoctorReport({ run = runCommand, env = process.env, nodeVersion = process.versions.node } = {}) {
  const report = {
    node: nodeInfo(nodeVersion),
    npm: commandVersion('npm', ['--version'], run),
    jq: commandVersion('jq', ['--version'], run),
    claude: commandVersion('claude', ['--version'], run),
    codex: codexInfo(run),
    copilot: commandVersion('copilot', ['--version'], run),
    runtime: {
      adapter: env.COPILOT_RUNTIME_ADAPTER || 'acp',
      dir: runtimeDir(),
      socket: daemonSocketPath(),
      queue: queuePath(),
      bridgeLog: bridgeLogFile(),
      daemonLog: daemonLogFile(),
      promptJsonlDir: promptJsonlDir(),
      digestDir: digestDir(),
    },
  };

  report.ok = Boolean(
    report.node.ok &&
    report.npm.found &&
    report.jq.found &&
    report.copilot.found &&
    (report.claude.found || report.codex.found)
  );

  return report;
}

export function renderDoctorReport(report) {
  return [
    `copilot-companion doctor: ${report.ok ? 'ok' : 'needs attention'}`,
    `node:    ${report.node.version} (${report.node.ok ? 'ok' : `requires ${report.node.required}`})`,
    `npm:     ${report.npm.version || 'missing'}`,
    `jq:      ${report.jq.version || 'missing'}`,
    `claude:  ${report.claude.version || 'missing'}`,
    `codex:   ${report.codex.version || 'missing'}${report.codex.found ? ` (plugin add: ${report.codex.pluginAdd ? 'ok' : 'missing'})` : ''}`,
    `copilot: ${report.copilot.version || 'missing'}`,
    `runtime: ${report.runtime.dir} (adapter: ${report.runtime.adapter})`,
  ].join('\n');
}
