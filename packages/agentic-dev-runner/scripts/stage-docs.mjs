import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
await copyFile(`${root}/README.md`, fileURLToPath(new URL("../README.md", import.meta.url)));
await copyFile(`${root}/LICENSE`, fileURLToPath(new URL("../LICENSE", import.meta.url)));
await copyFile(`${root}/THIRD-PARTY-NOTICES.md`, fileURLToPath(new URL("../THIRD-PARTY-NOTICES.md", import.meta.url)));
