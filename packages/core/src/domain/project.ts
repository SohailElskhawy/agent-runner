import type { IsoTimestamp } from "./timestamp.js";

export type Project = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};
