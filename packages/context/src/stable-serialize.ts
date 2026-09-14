export function stableStringify(value: unknown): string {
  return serializeValue(value);
}

function serializeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeValue(item)).join(",")}]`;
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const parts = keys.map(
        (key) => `${JSON.stringify(key)}:${serializeValue(record[key])}`,
      );
      return `{${parts.join(",")}}`;
    }
    default:
      return "null";
  }
}
