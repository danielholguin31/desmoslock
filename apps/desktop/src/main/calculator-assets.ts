import fs from "node:fs/promises";
import path from "node:path";

import type { StaticProtocolAsset } from "./static-protocol.js";

export interface CalculatorAssetDefinition {
  readonly contentType: string;
  readonly fileName: string;
  readonly resourceType: "mainFrame" | "script" | "stylesheet";
  readonly url: string;
}

const calculatorAssetDefinitions = [
  {
    contentType: "text/html; charset=utf-8",
    fileName: "index.html",
    resourceType: "mainFrame",
    url: "desmoslock-calculator://host/index.html",
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
] as const satisfies readonly CalculatorAssetDefinition[];

export const calculatorAssetManifest = Object.freeze(
  calculatorAssetDefinitions.map((asset) => Object.freeze(asset)),
);

const documentAsset = calculatorAssetManifest.find(
  (asset) => asset.resourceType === "mainFrame",
);
if (documentAsset === undefined) {
  throw new Error("Calculator asset manifest requires a main document");
}

export const calculatorDocumentUrl = documentAsset.url;
export const calculatorScheme = new URL(calculatorDocumentUrl).protocol.slice(
  0,
  -1,
);

export const calculatorResourceManifest = Object.freeze(
  calculatorAssetManifest.map(({ resourceType, url }) =>
    Object.freeze({ resourceType, url }),
  ),
);

export async function loadCalculatorProtocolAssets(
  outputDirectory: string,
): Promise<Readonly<Record<string, StaticProtocolAsset>>> {
  const contents = await Promise.all(
    calculatorAssetManifest.map((asset) =>
      fs.readFile(path.join(outputDirectory, "calculator", asset.fileName)),
    ),
  );

  return Object.freeze(
    Object.fromEntries(
      calculatorAssetManifest.map((asset, index) => {
        const content = contents[index];
        if (content === undefined) {
          throw new Error(`Calculator asset is missing: ${asset.fileName}`);
        }
        return [
          asset.url,
          Object.freeze({
            body: Uint8Array.from(content).buffer,
            contentType: asset.contentType,
          }),
        ];
      }),
    ),
  );
}
