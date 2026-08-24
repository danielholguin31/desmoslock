import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const INTERNAL_PURL = /^pkg:npm\/(?:%40|@)desmoslock\//u;
const DENIED_LICENSE =
  /\b(?:AGPL|GPL|SSPL|BUSL|Commons Clause|Elastic License)\b/iu;

export function isInternalComponent(component) {
  const purl = typeof component?.purl === "string" ? component.purl : "";
  if (INTERNAL_PURL.test(purl)) {
    return true;
  }
  if (component?.group === "@desmoslock") {
    return true;
  }
  return (
    typeof component?.name === "string" &&
    component.name.startsWith("@desmoslock/")
  );
}

function declaredLicenses(component) {
  return (component.licenses ?? [])
    .map(
      (entry) => entry.expression ?? entry.license?.id ?? entry.license?.name,
    )
    .filter((license) => typeof license === "string" && license.length > 0);
}

export function verifySbomLicenses(sbom) {
  const observedLicenses = new Set();
  let internalCount = 0;
  let externalCount = 0;

  for (const component of sbom.components ?? []) {
    if (isInternalComponent(component)) {
      internalCount += 1;
      continue;
    }

    externalCount += 1;
    const licenses = declaredLicenses(component);
    if (licenses.length === 0) {
      throw new Error(
        `${component.name}@${component.version} has no declared license`,
      );
    }
    for (const license of licenses) {
      observedLicenses.add(license);
      if (DENIED_LICENSE.test(license)) {
        throw new Error(
          `${component.name}@${component.version} uses denied license ${license}`,
        );
      }
    }
  }

  return {
    externalCount,
    internalCount,
    observedLicenses,
  };
}

function isCli() {
  const entry = process.argv[1];
  return (
    typeof entry === "string" &&
    pathToFileURL(path.resolve(entry)).href === import.meta.url
  );
}

if (isCli()) {
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
  const result = verifySbomLicenses(sbom);

  process.stdout.write(
    `SBOM license policy passed for ${sbom.components.length} components (${result.internalCount} internal, ${result.externalCount} external; ${[
      ...result.observedLicenses,
    ]
      .sort()
      .join(", ")}).\n`,
  );
}
