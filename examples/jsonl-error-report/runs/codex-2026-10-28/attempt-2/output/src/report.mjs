import { createInterface } from 'node:readline';

const counts = new Map();
let lineNumber = 0;
let invalid = false;

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  lineNumber++;
  if (!line.trim()) continue;

  let record;
  try {
    record = JSON.parse(line);
  } catch {
    invalid = true;
  }
  if (invalid || record === null || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.service !== 'string' || typeof record.level !== 'string') {
    console.error(`Invalid record on line ${lineNumber}`);
    process.exitCode = 1;
    invalid = true;
    break;
  }
  if (record.level === 'error') {
    counts.set(record.service, (counts.get(record.service) ?? 0) + 1);
  }
}

if (!invalid) {
  const entries = [...counts.keys()].sort().map(service => `${JSON.stringify(service)}:${counts.get(service)}`);
  process.stdout.write(`{${entries.join(',')}}\n`);
}
