import type { Session } from "electron";

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

export function denyDisallowedNavigation(
  event: Electron.Event,
  url: string,
  controlledProtocol: string,
  policy: SessionCapabilityPolicy,
): boolean {
  let usesControlledProtocol = false;
  try {
    usesControlledProtocol = new URL(url).protocol === controlledProtocol;
  } catch {
    // Malformed URLs are treated as external and denied below.
  }

  const allowed = usesControlledProtocol
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
  let usesControlledProtocol = false;
  try {
    usesControlledProtocol = new URL(url).protocol === controlledProtocol;
  } catch {
    // Malformed URLs are treated as external and denied below.
  }
  const allowed = usesControlledProtocol
    ? policy.allowsPopup(url)
    : policy.allowsExternalProtocol(url);
  return { action: allowed ? "allow" : "deny" };
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
    for (const reset of resets) {
      try {
        reset();
      } catch {
        // Every remaining fail-closed reset still gets a chance to run.
      }
    }
  };
}
