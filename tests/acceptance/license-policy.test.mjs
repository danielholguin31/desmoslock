import assert from "node:assert/strict";
import test from "node:test";

import {
  isInternalComponent,
  verifySbomLicenses,
} from "../../scripts/verify-licenses.mjs";

test("internal components are recognized from a scoped npm PURL even when name is unscoped", () => {
  const domain = {
    name: "domain",
    version: "2.0.0",
    purl: "pkg:npm/%40desmoslock/domain@2.0.0",
  };
  const desktop = {
    name: "desktop",
    version: "2.0.0",
    purl: "pkg:npm/@desmoslock/desktop@2.0.0",
  };

  assert.equal(isInternalComponent(domain), true);
  assert.equal(isInternalComponent(desktop), true);
  assert.doesNotThrow(() =>
    verifySbomLicenses({
      bomFormat: "CycloneDX",
      components: [domain, desktop],
    }),
  );
});

test("an unscoped public package is not treated as internal just because its name matches a workspace", () => {
  assert.equal(
    isInternalComponent({
      name: "domain",
      version: "0.8.2",
      purl: "pkg:npm/domain@0.8.2",
    }),
    false,
  );
});

test("external unlicensed components still fail the license policy", () => {
  assert.throws(
    () =>
      verifySbomLicenses({
        bomFormat: "CycloneDX",
        components: [
          {
            name: "domain",
            version: "2.0.0",
            purl: "pkg:npm/%40desmoslock/domain@2.0.0",
          },
          {
            name: "left-pad",
            version: "1.3.0",
            purl: "pkg:npm/left-pad@1.3.0",
          },
        ],
      }),
    /left-pad@1\.3\.0 has no declared license/,
  );
});

test("external components with denied licenses still fail the license policy", () => {
  assert.throws(
    () =>
      verifySbomLicenses({
        bomFormat: "CycloneDX",
        components: [
          {
            name: "copyleft-tool",
            version: "9.0.0",
            purl: "pkg:npm/copyleft-tool@9.0.0",
            licenses: [{ license: { id: "GPL-3.0-only" } }],
          },
        ],
      }),
    /copyleft-tool@9\.0\.0 uses denied license GPL-3.0-only/,
  );
});
