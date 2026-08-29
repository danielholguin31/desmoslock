import { contextBridge, ipcRenderer } from "electron";

import {
  createTrustedDesktopBridge,
  type TrustedBridgeResult,
} from "./trusted-bridge.js";

const trustedDesktopBridge = createTrustedDesktopBridge(
  async (channel, request) =>
    ipcRenderer.invoke(channel, request) as Promise<TrustedBridgeResult>,
);

contextBridge.exposeInMainWorld("desmoslockDesktop", trustedDesktopBridge);
