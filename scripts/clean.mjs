import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

for (const relativePath of [
  "apps/desktop/dist",
  "apps/web/dist",
  "artifacts",
  "packages/contracts/dist",
  "packages/domain/dist",
  "packages/test-support/dist",
]) {
  await fs.rm(path.join(repositoryRoot, relativePath), {
    force: true,
    recursive: true,
  });
}
