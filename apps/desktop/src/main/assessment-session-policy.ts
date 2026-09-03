import { calculatorDocumentUrl } from "./calculator-assets.js";

export interface AssessmentNetworkRequest {
  readonly method: string;
  readonly resourceType: string;
  readonly url: string;
  readonly webContentsId: number | undefined;
}

export interface AssessmentSessionPolicy {
  allowsDownload(): boolean;
  allowsExternalProtocol(url: string): boolean;
  allowsInitialDocument(url: string): boolean;
  allowsNavigation(url: string): boolean;
  allowsNetworkRequest(request: AssessmentNetworkRequest): boolean;
  allowsPermission(permission: string): boolean;
  allowsPopup(url: string): boolean;
}

export interface AssessmentSessionPolicyOptions {
  readonly allowedResources: readonly {
    readonly resourceType: string;
    readonly url: string;
  }[];
  readonly webContentsId: number;
}

function isExactUrl(candidate: string, expected: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.href === candidate && expected.has(candidate);
  } catch {
    return false;
  }
}

function isCalculatorOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.href === url &&
      parsed.protocol === "desmoslock-calculator:" &&
      parsed.hostname === "host" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

export function createAssessmentSessionPolicy(
  options: AssessmentSessionPolicyOptions,
): AssessmentSessionPolicy {
  const allowedResources = new Map<string, string>();
  for (const resource of options.allowedResources) {
    if (!isCalculatorOrigin(resource.url)) {
      throw new Error(
        "Assessment resource manifest contains an invalid origin",
      );
    }
    allowedResources.set(resource.url, resource.resourceType);
  }
  const allowedResourceUrls = new Set(allowedResources.keys());
  const initialDocument = new Set([calculatorDocumentUrl]);

  return Object.freeze({
    allowsDownload: () => false,
    allowsExternalProtocol: () => false,
    allowsInitialDocument: (url: string) => isExactUrl(url, initialDocument),
    allowsNavigation: () => false,
    allowsNetworkRequest: (request: AssessmentNetworkRequest) =>
      request.webContentsId === options.webContentsId &&
      request.method === "GET" &&
      isExactUrl(request.url, allowedResourceUrls) &&
      allowedResources.get(request.url) === request.resourceType,
    allowsPermission: () => false,
    allowsPopup: () => false,
  });
}
