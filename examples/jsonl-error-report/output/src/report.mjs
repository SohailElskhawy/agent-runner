#!/usr/bin/env node
// Count records with level "error" by service; report results as sorted JSON.
import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8');
const counts = new Map();
const lines = input.split('\n');

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.trim() === '') continue;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    console.error(`invalid JSON on line ${i + 1}`);
    process.exit(1);
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)
    || typeof record.service !== 'string' || typeof record.level !== 'string') {
    console.error(`invalid record on line ${i + 1}`);
    process.exit(1);
  }
  if (record.level === 'error') {
    counts.set(record.service, (counts.get(record.service) ?? 0) + 1);
  }
}

let out = '';
for (const service of [...counts.keys()].sort()) {
  out += (out ? ',' : '') + JSON.stringify(service) + ':' + counts.get(service);
}
console.log('{' + out + '}');
