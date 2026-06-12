import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(HERE, 'copilot-companion.md'), 'utf8');

test('Claude template documents status response rendering explicitly', () => {
  assert.match(text, /Status envelope/);
  assert.match(text, /response has `action: "status"` and `ok: true`/);
  assert.match(text, /never emit `undefined`/);
  assert.match(text, /echo "\$CLAUDE_CODE_SESSION_ID"/);
});
