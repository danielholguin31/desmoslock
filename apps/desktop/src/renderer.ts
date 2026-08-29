import type { TrustedDesktopBridge } from "./trusted-bridge.js";

declare global {
  interface Window {
    readonly desmoslockDesktop?: TrustedDesktopBridge;
  }
}

const status = document.querySelector<HTMLElement>("[data-v2-status]");
const lockIntent =
  document.querySelector<HTMLButtonElement>("[data-lock-intent]");
const bridge = window.desmoslockDesktop;

if (status !== null && lockIntent !== null) {
  if (bridge === undefined) {
    status.textContent = "Trusted shell bridge unavailable";
  } else {
    status.textContent = "Trusted shell ready · calculator isolated below";
    lockIntent.disabled = false;
    lockIntent.addEventListener("click", async () => {
      lockIntent.disabled = true;
      const result = await bridge.requestLock();
      status.textContent = result.ok
        ? "Main process accepted the synthetic lock intent"
        : `Lock intent denied: ${result.reason}`;
      lockIntent.disabled = false;
    });
  }
}
