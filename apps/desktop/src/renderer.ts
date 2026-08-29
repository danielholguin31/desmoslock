import type { TrustedDesktopBridge } from "./trusted-bridge.js";

declare global {
  interface Window {
    readonly desmoslockDesktop?: TrustedDesktopBridge;
  }
}

const status = document.querySelector<HTMLElement>("[data-v2-status]");
const bridge = window.desmoslockDesktop;

if (status !== null) {
  status.textContent =
    bridge === undefined
      ? "Secure assessment controls unavailable"
      : "Secure calculator ready";
}
