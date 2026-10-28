import { createInterface } from 'node:readline';

const counts = new Map();
let lineNumber = 0;
let valid = true;

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  lineNumber++;
  if (!line.trim()) continue;

  let record;
  try {
    record = JSON.parse(line);
  } catch {
    record = null;
  }

  if (record === null || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.service !== 'string' || typeof record.level !== 'string') {
    console.error(`Invalid record on line ${lineNumber}`);
    process.exitCode = 1;
    valid = false;
    break;
  }

  if (record.level === 'error') {
    counts.set(record.service, (counts.get(record.service) ?? 0) + 1);
  }
}

if (valid) {
  const entries = [...counts.keys()].sort().map(service =>
    `${JSON.stringify(service)}:${counts.get(service)}`);
  process.stdout.write(`{${entries.join(',')}}\n`);
}
