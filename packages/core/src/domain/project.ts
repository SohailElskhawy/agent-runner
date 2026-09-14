import type { IsoTimestamp } from "./timestamp.js";
import type { ProjectId } from "./ids.js";

export type Project = {
  id: ProjectId;
  name: string;
  rootPath: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};
