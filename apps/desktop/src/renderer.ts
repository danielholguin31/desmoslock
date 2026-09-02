import { updateDesktopBackendStatus } from "./backend-status.js";

const status = document.querySelector<HTMLElement>("[data-v2-status]");

if (status !== null) {
  void updateDesktopBackendStatus(status, globalThis.fetch.bind(globalThis));
}
