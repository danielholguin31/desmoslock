import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const artifactsRoot = path.join(repositoryRoot, "artifacts");
const outputPath = path.join(artifactsRoot, "desmoslock-v2.cdx.json");

const raw = execFileSync(
  "npm",
  ["sbom", "--all", "--sbom-format", "cyclonedx"],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  },
);
const sbom = JSON.parse(raw);

if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
  throw new Error("npm did not produce a CycloneDX component inventory");
}

fs.mkdirSync(artifactsRoot, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, {
  flag: "w",
  mode: 0o600,
});

process.stdout.write(
  `Wrote CycloneDX SBOM with ${sbom.components.length} components to ${path.relative(repositoryRoot, outputPath)}.\n`,
);
