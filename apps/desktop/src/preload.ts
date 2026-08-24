import {
  trustedIpcChannels,
  type TrustedIpcChannel,
} from "@desmoslock/contracts";

export interface TrustedDesktopBridge {
  readonly channels: readonly TrustedIpcChannel[];
  readonly version: "2.0.0";
}

export const trustedDesktopBridge: TrustedDesktopBridge = Object.freeze({
  channels: trustedIpcChannels,
  version: "2.0.0",
});
