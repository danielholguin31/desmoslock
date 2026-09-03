export type StaffAuthCallbackFlow =
  "email_verification" | "password_recovery" | "sign_in";

export type StaffAuthCallbackStateResult = "accepted" | "invalid" | "replayed";

export interface StaffAuthCallbackStateStore {
  /** Atomically consumes a state value bound to one exact callback flow. */
  consume(input: {
    readonly flow: StaffAuthCallbackFlow;
    readonly state: string;
  }): Promise<StaffAuthCallbackStateResult>;
}

export interface StaffAuthCallbackHistory {
  replaceState(data: null, unused: string, url: string): void;
}

export interface StaffAuthCallbackRoute {
  readonly origin: string;
  readonly pathname: string;
}

export type StaffAuthCallbackReceipt =
  | {
      readonly code: "accepted";
      readonly flow: StaffAuthCallbackFlow;
      readonly status: "accepted";
    }
  | {
      readonly code:
        | "exchange_unavailable"
        | "invalid_callback"
        | "invalid_flow"
        | "malformed_callback"
        | "provider_rejected"
        | "state_mismatch"
        | "state_replayed"
        | "state_unavailable";
      readonly status: "rejected";
    };

export async function consumeStaffAuthPkceCallback(
  callbackUrl: string,
  options: {
    readonly exchange: (input: {
      readonly authorizationCode: string;
      readonly flow: StaffAuthCallbackFlow;
    }) => Promise<void>;
    readonly history: StaffAuthCallbackHistory;
    readonly route: StaffAuthCallbackRoute;
    readonly states: StaffAuthCallbackStateStore;
  },
): Promise<StaffAuthCallbackReceipt> {
  const trustedRoute = parseTrustedRoute(options.route);

  // Scrub the browser address synchronously. No state lookup, token exchange, or
  // other awaited work may happen while callback credentials remain visible.
  try {
    options.history.replaceState(null, "", trustedRoute?.pathname ?? "/");
  } catch {
    return rejected("invalid_callback");
  }

  if (trustedRoute === null || callbackUrl.length > 4096) {
    return rejected("invalid_callback");
  }

  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return rejected("invalid_callback");
  }

  if (
    url.origin !== trustedRoute.origin ||
    url.pathname !== trustedRoute.pathname ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return rejected("invalid_callback");
  }

  const entries = [...url.searchParams.entries()];
  const exactKeys = new Set(entries.map(([key]) => key));
  if (
    [...exactKeys].some(
      (key) =>
        key !== "code" && key !== "error" && key !== "flow" && key !== "state",
    ) ||
    url.searchParams.getAll("code").length > 1 ||
    url.searchParams.getAll("error").length > 1 ||
    url.searchParams.getAll("flow").length !== 1 ||
    url.searchParams.getAll("state").length !== 1
  ) {
    return rejected("malformed_callback");
  }

  const flow = parseFlow(url.searchParams.get("flow"));
  if (flow === null) {
    return rejected("invalid_flow");
  }
  const state = url.searchParams.get("state");
  if (state === null || state.length === 0 || state.length > 512) {
    return rejected("malformed_callback");
  }

  const providerError = url.searchParams.get("error");
  const authorizationCode = url.searchParams.get("code");
  const isProviderRejection = providerError !== null;
  if (
    entries.length !== 3 ||
    exactKeys.size !== 3 ||
    (isProviderRejection &&
      (providerError === "" || authorizationCode !== null)) ||
    (!isProviderRejection &&
      (authorizationCode === null ||
        authorizationCode.length === 0 ||
        authorizationCode.length > 2048))
  ) {
    return rejected("malformed_callback");
  }

  let stateResult: StaffAuthCallbackStateResult;
  try {
    stateResult = await options.states.consume({ flow, state });
  } catch {
    return rejected("state_unavailable");
  }
  if (stateResult === "replayed") {
    return rejected("state_replayed");
  }
  if (stateResult !== "accepted") {
    return rejected("state_mismatch");
  }
  if (isProviderRejection) {
    return rejected("provider_rejected");
  }

  try {
    await options.exchange({
      authorizationCode: authorizationCode as string,
      flow,
    });
  } catch {
    return rejected("exchange_unavailable");
  }
  return { code: "accepted", flow, status: "accepted" };
}

function parseTrustedRoute(
  route: StaffAuthCallbackRoute,
): StaffAuthCallbackRoute | null {
  if (
    route.pathname.length === 0 ||
    !route.pathname.startsWith("/") ||
    route.pathname.startsWith("//") ||
    route.pathname.includes("?") ||
    route.pathname.includes("#") ||
    route.pathname.includes("\\")
  ) {
    return null;
  }
  let origin: URL;
  try {
    origin = new URL(route.origin);
  } catch {
    return null;
  }
  const loopbackHostname =
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "localhost" ||
    origin.hostname === "[::1]";
  if (
    origin.origin !== route.origin ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.username !== "" ||
    origin.password !== "" ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && loopbackHostname))
  ) {
    return null;
  }
  return { origin: origin.origin, pathname: route.pathname };
}

function parseFlow(value: string | null): StaffAuthCallbackFlow | null {
  if (
    value === "email_verification" ||
    value === "password_recovery" ||
    value === "sign_in"
  ) {
    return value;
  }
  return null;
}

function rejected(
  code: Exclude<StaffAuthCallbackReceipt["code"], "accepted">,
): StaffAuthCallbackReceipt {
  return { code, status: "rejected" };
}
