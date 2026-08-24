import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sbomPath = path.join(
  repositoryRoot,
  "artifacts",
  "desmoslock-v2.cdx.json",
);
const sbom = JSON.parse(fs.readFileSync(sbomPath, "utf8"));
const deniedLicense =
  /\b(?:AGPL|GPL|SSPL|BUSL|Commons Clause|Elastic License)\b/iu;
const observedLicenses = new Set();

for (const component of sbom.components ?? []) {
  if (String(component.name).startsWith("@desmoslock/")) continue;

  const licenses = (component.licenses ?? [])
    .map(
      (entry) => entry.expression ?? entry.license?.id ?? entry.license?.name,
    )
    .filter((license) => typeof license === "string" && license.length > 0);

  if (licenses.length === 0) {
    throw new Error(
      `${component.name}@${component.version} has no declared license`,
    );
  }
  for (const license of licenses) {
    observedLicenses.add(license);
    if (deniedLicense.test(license)) {
      throw new Error(
        `${component.name}@${component.version} uses denied license ${license}`,
      );
    }
  }
}

process.stdout.write(
  `SBOM license policy passed for ${sbom.components.length} components (${[
    ...observedLicenses,
  ]
    .sort()
    .join(", ")}).\n`,
);
