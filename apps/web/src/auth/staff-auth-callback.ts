export type StaffAuthCallbackReceipt =
  | { readonly code: "accepted"; readonly status: "accepted" }
  | {
      readonly code:
        | "exchange_unavailable"
        | "invalid_callback"
        | "malformed_callback"
        | "provider_rejected"
        | "state_mismatch";
      readonly status: "rejected";
    };

export async function consumeStaffAuthPkceCallback(
  callbackUrl: string,
  options: {
    readonly exchange: (authorizationCode: string) => Promise<void>;
    readonly expectedState: string;
  },
): Promise<StaffAuthCallbackReceipt> {
  if (
    callbackUrl.length > 4096 ||
    options.expectedState.length === 0 ||
    options.expectedState.length > 512
  ) {
    return { code: "invalid_callback", status: "rejected" };
  }
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return { code: "invalid_callback", status: "rejected" };
  }

  const loopbackHostname =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && loopbackHostname))
  ) {
    return { code: "invalid_callback", status: "rejected" };
  }

  const entries = [...url.searchParams.entries()];
  const exactKeys = new Set(entries.map(([key]) => key));
  if (
    url.hash !== "" ||
    [...exactKeys].some(
      (key) => key !== "code" && key !== "error" && key !== "state",
    ) ||
    url.searchParams.getAll("code").length > 1 ||
    url.searchParams.getAll("error").length > 1 ||
    url.searchParams.getAll("state").length > 1
  ) {
    return { code: "malformed_callback", status: "rejected" };
  }

  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  if (providerError !== null) {
    if (
      providerError === "" ||
      state === null ||
      entries.length !== 2 ||
      exactKeys.size !== 2 ||
      exactKeys.has("code")
    ) {
      return { code: "malformed_callback", status: "rejected" };
    }
    if (!constantTimeTextEqual(state, options.expectedState)) {
      return { code: "state_mismatch", status: "rejected" };
    }
    return { code: "provider_rejected", status: "rejected" };
  }

  const authorizationCode = url.searchParams.get("code");
  if (
    entries.length !== 2 ||
    exactKeys.size !== 2 ||
    authorizationCode === null ||
    authorizationCode === "" ||
    authorizationCode.length > 2048 ||
    state === null
  ) {
    return { code: "invalid_callback", status: "rejected" };
  }
  if (!constantTimeTextEqual(state, options.expectedState)) {
    return { code: "state_mismatch", status: "rejected" };
  }
  try {
    await options.exchange(authorizationCode);
  } catch {
    return { code: "exchange_unavailable", status: "rejected" };
  }
  return { code: "accepted", status: "accepted" };
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
