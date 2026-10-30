import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const cli = join(__dirname, '..', 'src', 'report.cjs');
function run(input) {
  return spawnSync(process.execPath, [cli], { input, encoding: 'utf8' });
}
test('counts error events by service in sorted JSON', () => {
  const result = run('{"service":"worker","level":"error"}\n{"service":"api","level":"error"}\n{"service":"api","level":"info"}\n{"service":"worker","level":"error"}\n');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '{"api":1,"worker":2}');
});
test('ignores blank lines', () => {
  const result = run('\n  \n{"service":"api","level":"error"}\n\n');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '{"api":1}');
});
test('rejects malformed and invalid records with the physical line number', () => {
  for (const record of ['{', 'null', '[]', '{"service":1,"level":"error"}', '{"service":"api","level":false}']) {
    const result = run('\n' + record + '\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /line\s+2\b/i);
  }
});

test('reports the bundled service log', () => {
  const result = run(readFileSync(join(__dirname, '..', 'data', 'service.jsonl'), 'utf8'));
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '{"api":1,"worker":2}');
});
