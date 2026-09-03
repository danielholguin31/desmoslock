import { updateDesktopBackendStatus } from "./backend-status.js";
import type { TrustedDesktopBridge } from "./trusted-bridge.js";

declare global {
  interface Window {
    readonly desmoslockDesktop?: TrustedDesktopBridge;
  }
}
const status = document.querySelector<HTMLElement>("[data-v2-status]");
const bridge = window.desmoslockDesktop;

if (status !== null) {
  if (bridge === undefined) {
    status.textContent = "Secure assessment controls unavailable";
  } else {
    void updateDesktopBackendStatus(status, globalThis.fetch.bind(globalThis));
  }
}
