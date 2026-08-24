import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packages = [
  ["@desmoslock/contracts", "packages/contracts"],
  ["@desmoslock/desktop", "apps/desktop"],
  ["@desmoslock/domain", "packages/domain"],
  ["@desmoslock/test-support", "packages/test-support"],
  ["@desmoslock/web", "apps/web"],
];

for (const [packageName, packageRoot] of packages) {
  const raw = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--workspace", packageName],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const [result] = JSON.parse(raw);
  if (result === undefined || !Array.isArray(result.files)) {
    throw new Error(`npm pack returned no file inventory for ${packageName}`);
  }

  const filenames = result.files.map((file) => file.path).sort();
  if (
    !filenames.includes("package.json") ||
    !filenames.some((file) => file.startsWith("dist/"))
  ) {
    throw new Error(
      `${packageName} package is missing package.json or dist output`,
    );
  }
  for (const filename of filenames) {
    if (filename !== "package.json" && !filename.startsWith("dist/")) {
      throw new Error(`${packageName} includes unexpected file ${filename}`);
    }
    if (
      /AppImage|linux|quote|manual[-_ ]?licen[sc]|server\/|web\/admin/i.test(
        filename,
      )
    ) {
      throw new Error(
        `${packageName} includes unsupported legacy artifact path ${filename}`,
      );
    }
  }

  if (packageName !== "@desmoslock/test-support") {
    for (const file of result.files) {
      if (!file.path.startsWith("dist/") || file.path.endsWith(".map"))
        continue;
      const absolutePath = path.join(repositoryRoot, packageRoot, file.path);
      const contents = fs.readFileSync(absolutePath, "utf8");
      if (
        /@desmoslock\/test-support|localhost:4000|AppImage|quote_requests/.test(
          contents,
        )
      ) {
        throw new Error(
          `${packageName} output ${file.path} contains a forbidden production reference`,
        );
      }
    }
  }
}

process.stdout.write(
  "Package dry runs contain only guarded v2 build output.\n",
);
