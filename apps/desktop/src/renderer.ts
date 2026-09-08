import { bindStudentSessionView } from "./student-session-view.js";
import type { TrustedDesktopBridge } from "./trusted-bridge.js";

declare global {
  interface Window {
    readonly desmoslockDesktop?: TrustedDesktopBridge;
  }
}
const root = document.querySelector<HTMLElement>("[data-student-session-root]");
const bridge = window.desmoslockDesktop;

if (root !== null) {
  const dispose = bindStudentSessionView(root, bridge);
  window.addEventListener("pagehide", dispose, { once: true });
}
