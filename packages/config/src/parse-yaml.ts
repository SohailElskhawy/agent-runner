import { parse as parseYaml } from "yaml";

export type ProjectConfigYamlParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

const STRICT_PARSE_OPTIONS = {
  merge: false,
  uniqueKeys: true,
} as const;

export function parseProjectConfigYaml(
  source: string,
): ProjectConfigYamlParseResult {
  try {
    const value: unknown = parseYaml(source, STRICT_PARSE_OPTIONS);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: toMessage(error) };
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
