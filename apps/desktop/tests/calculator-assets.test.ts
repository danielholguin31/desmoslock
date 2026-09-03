import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  calculatorAssetManifest,
  calculatorDocumentUrl,
  calculatorResourceManifest,
  loadCalculatorProtocolAssets,
} from "../src/main/calculator-assets.js";

describe("calculator asset manifest", () => {
  it("derives the network allowlist from one immutable typed asset inventory", () => {
    expect(calculatorAssetManifest).toEqual([
      {
        contentType: "text/html; charset=utf-8",
        fileName: "index.html",
        resourceType: "mainFrame",
        url: calculatorDocumentUrl,
      },
      {
        contentType: "text/javascript; charset=utf-8",
        fileName: "host.js",
        resourceType: "script",
        url: "desmoslock-calculator://host/host.js",
      },
      {
        contentType: "text/css; charset=utf-8",
        fileName: "styles.css",
        resourceType: "stylesheet",
        url: "desmoslock-calculator://host/styles.css",
      },
    ]);
    expect(calculatorResourceManifest).toEqual(
      calculatorAssetManifest.map(({ resourceType, url }) => ({
        resourceType,
        url,
      })),
    );
    expect(Object.isFrozen(calculatorAssetManifest)).toBe(true);
    expect(
      calculatorAssetManifest.every((asset) => Object.isFrozen(asset)),
    ).toBe(true);
    expect(Object.isFrozen(calculatorResourceManifest)).toBe(true);
  });

  it("loads protocol assets using only the manifest filenames", async () => {
    const outputDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "desmoslock-calculator-assets-"),
    );
    try {
      const calculatorDirectory = path.join(outputDirectory, "calculator");
      await fs.mkdir(calculatorDirectory);
      await Promise.all([
        fs.writeFile(path.join(calculatorDirectory, "index.html"), "document"),
        fs.writeFile(path.join(calculatorDirectory, "host.js"), "script"),
        fs.writeFile(path.join(calculatorDirectory, "styles.css"), "style"),
      ]);

      const assets = await loadCalculatorProtocolAssets(outputDirectory);

      expect(Object.keys(assets).sort()).toEqual(
        calculatorAssetManifest.map(({ url }) => url).sort(),
      );
      expect(
        new TextDecoder().decode(
          assets[calculatorDocumentUrl]?.body as ArrayBuffer,
        ),
      ).toBe("document");
      expect(assets[calculatorDocumentUrl]?.contentType).toBe(
        "text/html; charset=utf-8",
      );
    } finally {
      await fs.rm(outputDirectory, { force: true, recursive: true });
    }
  });
});
