import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const harness = join(dirname(fileURLToPath(import.meta.url)), '..', 'run.mjs');
test('rejects an invalid provider before creating the target and preserves an existing target', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsonl-harness-'));
  try {
    const target = join(root, 'target');
    const invalid = spawnSync(process.execPath, [harness, target, 'invalid'], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Usage:/);
    assert.equal(existsSync(target), false);
    mkdirSync(target);
    writeFileSync(join(target, 'sentinel'), 'unchanged');
    const existing = spawnSync(process.execPath, [harness, target, 'codex'], { encoding: 'utf8' });
    assert.notEqual(existing.status, 0);
    assert.match(existing.stderr, /EEXIST/);
    assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
