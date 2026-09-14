import type { IsoTimestamp } from "./timestamp.js";

export type ContextManifestEntry = {
  kind: string;
  source: string;
  digest?: string;
};

export type ContextManifest = {
  entries: readonly ContextManifestEntry[];
  createdAt: IsoTimestamp;
};
