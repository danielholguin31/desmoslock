import type { Session, WebContents } from "electron";

export interface SessionCapabilityPolicy {
  allowsDownload(): boolean;
  allowsExternalProtocol(url: string): boolean;
  allowsNavigation(url: string): boolean;
  allowsPermission(permission: string): boolean;
  allowsPopup(url: string): boolean;
}

export const denyByDefaultCapabilityPolicy: SessionCapabilityPolicy =
  Object.freeze({
    allowsDownload: () => false,
    allowsExternalProtocol: () => false,
    allowsNavigation: () => false,
    allowsPermission: () => false,
    allowsPopup: () => false,
  });

function usesControlledProtocol(
  url: string,
  controlledProtocol: string,
): boolean {
  try {
    return new URL(url).protocol === controlledProtocol;
  } catch {
    return false;
  }
}

export function denyDisallowedNavigation(
  event: Electron.Event,
  url: string,
  controlledProtocol: string,
  policy: SessionCapabilityPolicy,
): boolean {
  const allowed = usesControlledProtocol(url, controlledProtocol)
    ? policy.allowsNavigation(url)
    : policy.allowsExternalProtocol(url);
  if (allowed) return false;

  event.preventDefault();
  return true;
}

export function decideWindowOpen(
  url: string,
  controlledProtocol: string,
  policy: SessionCapabilityPolicy,
): { readonly action: "allow" | "deny" } {
  const allowed = usesControlledProtocol(url, controlledProtocol)
    ? policy.allowsPopup(url)
    : policy.allowsExternalProtocol(url);
  return { action: allowed ? "allow" : "deny" };
}

export function installWebContentsEscapeDenial(
  webContents: WebContents,
  controlledProtocol: string,
  policy: SessionCapabilityPolicy,
): void {
  webContents.setWindowOpenHandler(({ url }) =>
    decideWindowOpen(url, controlledProtocol, policy),
  );
  const denyNavigation = (event: Electron.Event, url: string): void => {
    denyDisallowedNavigation(event, url, controlledProtocol, policy);
  };
  webContents.on("will-navigate", (event, url) => denyNavigation(event, url));
  webContents.on("will-frame-navigate", (event) =>
    denyNavigation(event, event.url),
  );
  webContents.on("will-redirect", (event, url) => denyNavigation(event, url));
  webContents.on("will-attach-webview", (event) => event.preventDefault());
}

export function installSessionDenialPolicy(
  targetSession: Session,
  policy: SessionCapabilityPolicy,
): () => void {
  const handleDownload = (event: Electron.Event): void => {
    if (policy.allowsDownload()) return;
    event.preventDefault();
  };
  const handleHidDevice = (
    event: Electron.Event,
    _details: Electron.SelectHidDeviceDetails,
    callback: (deviceId?: string | null) => void,
  ): void => {
    event.preventDefault();
    callback();
  };
  const handleUsbDevice = (
    event: Electron.Event,
    _details: Electron.SelectUsbDeviceDetails,
    callback: (deviceId?: string) => void,
  ): void => {
    event.preventDefault();
    callback();
  };
  const handleSerialPort = (
    event: Electron.Event,
    _ports: Electron.SerialPort[],
    _webContents: Electron.WebContents,
    callback: (portId: string) => void,
  ): void => {
    event.preventDefault();
    callback("");
  };

  targetSession.setPermissionCheckHandler((_webContents, permission) =>
    policy.allowsPermission(permission),
  );
  targetSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (permission === "openExternal") {
        const externalUrl =
          "externalURL" in details ? (details.externalURL ?? "") : "";
        const allowed = policy.allowsExternalProtocol(externalUrl);
        callback(allowed);
        return;
      }
      callback(policy.allowsPermission(permission));
    },
  );
  targetSession.setDevicePermissionHandler(() => false);
  targetSession.setDisplayMediaRequestHandler((_request, callback) =>
    callback({}),
  );
  targetSession.setSpellCheckerEnabled(false);
  targetSession.on("select-hid-device", handleHidDevice);
  targetSession.on("select-usb-device", handleUsbDevice);
  targetSession.on("select-serial-port", handleSerialPort);
  targetSession.on("will-download", handleDownload);

  return () => {
    const resets = [
      () => targetSession.setPermissionCheckHandler(null),
      () => targetSession.setPermissionRequestHandler(null),
      () => targetSession.setDevicePermissionHandler(null),
      () => targetSession.setDisplayMediaRequestHandler(null),
      () => targetSession.removeListener("select-hid-device", handleHidDevice),
      () => targetSession.removeListener("select-usb-device", handleUsbDevice),
      () =>
        targetSession.removeListener("select-serial-port", handleSerialPort),
      () => targetSession.removeListener("will-download", handleDownload),
    ];
    const failures: unknown[] = [];
    for (const reset of resets) {
      try {
        reset();
      } catch (error) {
        // Every remaining fail-closed reset still gets a chance to run.
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Electron session denial-policy uninstall failed",
      );
    }
  };
}
