import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDoctorReport, renderDoctorReport } from './doctor.mjs';

function withRuntimeHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-doctor-test-'));
  const prior = process.env.COPILOT_RUNTIME_DIR;
  process.env.COPILOT_RUNTIME_DIR = dir;
  try { return fn(dir); }
  finally {
    if (prior === undefined) delete process.env.COPILOT_RUNTIME_DIR;
    else process.env.COPILOT_RUNTIME_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('buildDoctorReport captures tool availability, runtime paths, and overall health', () => {
  withRuntimeHome((home) => {
    const seen = [];
    const run = (cmd, args = []) => {
      seen.push([cmd, args.join(' ')]);
      if (cmd === 'node-missing') return { ok: false, output: 'unused' };
      if (cmd === 'npm') return { ok: true, output: '10.0.0\nextra' };
      if (cmd === 'jq') return { ok: true, output: 'jq-1.7' };
      if (cmd === 'claude') return { ok: false, output: 'not found' };
      if (cmd === 'codex') {
        if (args.join(' ') === '--version') return { ok: true, output: 'codex 0.130.0' };
        if (args.join(' ') === 'plugin add --help') return { ok: true, output: 'usage' };
        if (args.join(' ') === 'plugin marketplace add --help') return { ok: false, output: 'missing' };
      }
      if (cmd === 'copilot') return { ok: true, output: 'copilot 1.0.0' };
      return { ok: false, output: 'missing' };
    };

    const report = buildDoctorReport({
      run,
      env: { COPILOT_RUNTIME_ADAPTER: 'sdk' },
      nodeVersion: '22.1.0',
    });

    assert.equal(report.ok, true);
    assert.equal(report.node.version, 'v22.1.0');
    assert.equal(report.npm.version, '10.0.0');
    assert.equal(report.claude.found, false);
    assert.equal(report.codex.found, true);
    assert.equal(report.codex.pluginAdd, true);
    assert.equal(report.codex.marketplaceAdd, false);
    assert.equal(report.copilot.version, 'copilot 1.0.0');
    assert.equal(report.runtime.adapter, 'sdk');
    assert.match(report.runtime.dir, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(seen.find(([cmd, args]) => cmd === 'codex' && args === 'plugin add --help'), ['codex', 'plugin add --help']);

    const rendered = renderDoctorReport(report);
    assert.match(rendered, /copilot-companion doctor: ok/);
    assert.match(rendered, /codex:   codex 0\.130\.0 \(plugin add: ok\)/);
    assert.match(rendered, /runtime: .* \(adapter: sdk\)/);
  });
});
