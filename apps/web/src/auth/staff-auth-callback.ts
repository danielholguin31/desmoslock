export type StaffAuthCallbackKind =
  "email-verification" | "invite" | "recovery";

export type StaffRecoveryFlowConsumeResult =
  | {
      readonly expiresAt: number;
      readonly state: string;
      readonly status: "accepted";
      readonly verifier: string;
    }
  | { readonly status: "invalid" | "replayed" };

export interface StaffRecoveryFlowStore {
  /** Generates, stores, and returns only the public PKCE request values. */
  create(): Promise<{
    readonly codeChallenge: string;
    readonly flowId: string;
    readonly state: string;
  }>;
  /** Non-consuming preflight before following a mailed verification link. */
  check?(flowId: string, state: string): Promise<boolean>;
  /** Atomically removes and returns one flow record; implementations cap at 16. */
  consume(flowId: string): Promise<StaffRecoveryFlowConsumeResult>;
}

export interface StaffAuthCallbackHistory {
  replaceState(data: null, unused: string, url: string): void;
}

export interface StaffAuthCallbackRoute {
  readonly origin: string;
  readonly pathname: "/";
}

export type StaffAuthCallbackReceipt =
  | {
      readonly code: "accepted";
      readonly kind: StaffAuthCallbackKind;
      readonly status: "accepted";
    }
  | {
      readonly code: "recovery_verification_started";
      readonly status: "redirecting";
    }
  | {
      readonly code:
        | "callback_already_used"
        | "invalid_callback"
        | "malformed_callback"
        | "recovery_flow_expired"
        | "recovery_flow_invalid"
        | "recovery_flow_replayed"
        | "recovery_flow_unavailable"
        | "recovery_state_mismatch"
        | "token_consumption_unavailable";
      readonly status: "rejected";
    };

type StaffAuthCallbackRejectedReceipt = Extract<
  StaffAuthCallbackReceipt,
  { readonly status: "rejected" }
>;

type CallbackConsumer = (tokenHash: string) => Promise<void>;

export type PreparedStaffRecoveryCallback =
  | StaffAuthCallbackRejectedReceipt
  | {
      readonly confirm: () => Promise<StaffAuthCallbackReceipt>;
      readonly status: "confirmation_required";
    }
  | {
      readonly exchange: () => Promise<StaffAuthCallbackReceipt>;
      readonly status: "exchange_required";
    };

/**
 * Scrubs and consumes one application-root invitation callback. The token hash
 * exists only as the synchronous argument to the injected one-shot boundary.
 */
export function consumeStaffInvitationCallback(
  callbackUrl: string,
  options: {
    readonly history: StaffAuthCallbackHistory;
    readonly inspect: CallbackConsumer;
    readonly route: StaffAuthCallbackRoute;
  },
): Promise<StaffAuthCallbackReceipt> {
  return consumeTokenHashCallback(
    callbackUrl,
    "invite",
    options.inspect,
    options,
  );
}

/**
 * Scrubs one SDK-owned email-verification PKCE callback before handing its
 * transient code and flow slot to Supabase Auth. The SDK owns and atomically
 * consumes the verifier stored for the exact flow ID.
 */
export function consumeStaffEmailVerificationCallback(
  callbackUrl: string,
  options: {
    readonly exchange: (input: {
      readonly authorizationCode: string;
      readonly flowId: string;
    }) => Promise<void>;
    readonly history: StaffAuthCallbackHistory;
    readonly route: StaffAuthCallbackRoute;
  },
): Promise<StaffAuthCallbackReceipt> {
  const route = scrubAndParseRoute(callbackUrl, options);
  if (route.status === "rejected") return Promise.resolve(route);
  const { url } = route;
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 3 ||
    url.searchParams.getAll("auth").length !== 1 ||
    url.searchParams.getAll("code").length !== 1 ||
    url.searchParams.getAll("sb_flow_id").length !== 1 ||
    entries.some(
      ([key]) => key !== "auth" && key !== "code" && key !== "sb_flow_id",
    ) ||
    url.searchParams.get("auth") !== "email-verification"
  ) {
    return Promise.resolve(rejected("malformed_callback"));
  }
  const authorizationCode = url.searchParams.get("code");
  const flowId = url.searchParams.get("sb_flow_id");
  if (
    authorizationCode === null ||
    authorizationCode.length === 0 ||
    authorizationCode !== authorizationCode.trim() ||
    encodedByteLength(authorizationCode) > 2048 ||
    hasControlText(authorizationCode) ||
    flowId === null ||
    !/^[A-Za-z0-9_-]{8,64}$/u.test(flowId)
  ) {
    return Promise.resolve(rejected("malformed_callback"));
  }
  return consumeEmailVerificationCode(authorizationCode, flowId, options);
}

/**
 * Validates a scrubbed recovery callback and returns only an opaque one-shot
 * command. Callback credentials remain captured by the command closure and are
 * never exposed through the returned result.
 */
export function prepareStaffRecoveryCallback(
  callbackUrl: string,
  options: {
    readonly backendOrigin: string;
    readonly exchange: (input: {
      readonly authorizationCode: string;
      readonly flowId: string;
      readonly state: string;
    }) => Promise<void>;
    readonly history: StaffAuthCallbackHistory;
    readonly navigate: (url: string) => void;
    readonly route: StaffAuthCallbackRoute;
  },
): PreparedStaffRecoveryCallback {
  const parsed = scrubAndParseRoute(callbackUrl, options, true);
  if (parsed.status === "rejected") return parsed;
  const backendOrigin = parseTrustedOrigin(options.backendOrigin);
  if (backendOrigin === null) return rejected("invalid_callback");

  const { url } = parsed;
  const appOrigin = url.origin;
  const searchEntries = [...url.searchParams.entries()];
  const flowId = url.searchParams.get("flow");
  const state = url.searchParams.get("state");
  if (
    searchEntries.length === 3 &&
    searchEntries[0]?.[0] === "auth" &&
    searchEntries[1]?.[0] === "flow" &&
    searchEntries[2]?.[0] === "state" &&
    url.searchParams.get("auth") === "recovery" &&
    isBase64Url(flowId, 22) &&
    isBase64Url(state, 43)
  ) {
    const fragmentEntries = [
      ...new URLSearchParams(url.hash.slice(1)).entries(),
    ];
    const tokenHash = fragmentEntries[0]?.[1];
    if (
      fragmentEntries.length !== 2 ||
      fragmentEntries[0]?.[0] !== "token_hash" ||
      fragmentEntries[1]?.[0] !== "type" ||
      fragmentEntries[1]?.[1] !== "recovery" ||
      tokenHash === undefined ||
      !isRecoveryVerificationToken(tokenHash) ||
      url.search !== `?auth=recovery&flow=${flowId}&state=${state}` ||
      url.hash !== `#token_hash=${tokenHash}&type=recovery`
    ) {
      return rejected("malformed_callback");
    }

    let captured:
      | {
          readonly flowId: string;
          readonly state: string;
          readonly tokenHash: string;
        }
      | undefined = { flowId, state, tokenHash };
    return {
      async confirm() {
        const current = captured;
        captured = undefined;
        if (current === undefined) return rejected("callback_already_used");
        const redirectTo = `${appOrigin}/?auth=recovery&flow=${current.flowId}&state=${current.state}`;
        const verification = new URL("/auth/v1/verify", backendOrigin);
        verification.searchParams.append("token", current.tokenHash);
        verification.searchParams.append("type", "recovery");
        verification.searchParams.append("redirect_to", redirectTo);
        try {
          options.navigate(verification.href);
        } catch {
          return rejected("token_consumption_unavailable");
        }
        return {
          code: "recovery_verification_started",
          status: "redirecting",
        };
      },
      status: "confirmation_required",
    };
  }

  const authorizationCode = url.searchParams.get("code");
  const codeQueryParts = url.search.slice(1).split("&");
  if (
    searchEntries.length === 4 &&
    new Set(searchEntries.map(([key]) => key)).size === 4 &&
    searchEntries.every(
      ([key]) =>
        key === "auth" || key === "flow" || key === "state" || key === "code",
    ) &&
    url.searchParams.get("auth") === "recovery" &&
    isBase64Url(flowId, 22) &&
    isBase64Url(state, 43) &&
    authorizationCode !== null &&
    authorizationCode.length > 0 &&
    authorizationCode === authorizationCode.trim() &&
    encodedByteLength(authorizationCode) <= 2048 &&
    !hasControlText(authorizationCode) &&
    url.hash === "" &&
    !callbackUrl.includes("#") &&
    codeQueryParts.length === 4 &&
    codeQueryParts.includes("auth=recovery") &&
    codeQueryParts.includes(`flow=${flowId}`) &&
    codeQueryParts.includes(`state=${state}`) &&
    codeQueryParts.some((part) => part.startsWith("code="))
  ) {
    let captured:
      | {
          readonly authorizationCode: string;
          readonly flowId: string;
          readonly state: string;
        }
      | undefined = { authorizationCode, flowId, state };
    return {
      async exchange() {
        const current = captured;
        captured = undefined;
        if (current === undefined) return rejected("callback_already_used");
        try {
          await options.exchange(current);
        } catch {
          return rejected("token_consumption_unavailable");
        }
        return { code: "accepted", kind: "recovery", status: "accepted" };
      },
      status: "exchange_required",
    };
  }

  return rejected("malformed_callback");
}

/** Called only after the application has obtained explicit confirmation. */
export async function consumeStaffRecoveryCallback(
  callbackUrl: string,
  options: {
    readonly backendOrigin?: string;
    readonly clock: { readonly now: () => number };
    readonly exchange: (input: {
      readonly authorizationCode: string;
      readonly verifier: string;
    }) => Promise<void>;
    readonly flows: StaffRecoveryFlowStore;
    readonly history: StaffAuthCallbackHistory;
    readonly navigate?: (url: string) => void;
    readonly route: StaffAuthCallbackRoute;
  },
): Promise<StaffAuthCallbackReceipt> {
  let flowReceipt: StaffAuthCallbackReceipt | null = null;
  const prepared = prepareStaffRecoveryCallback(callbackUrl, {
    backendOrigin: options.backendOrigin ?? options.route.origin,
    exchange: async ({ authorizationCode, flowId, state }) => {
      flowReceipt = await consumeRecoveryFlow(
        authorizationCode,
        flowId,
        state,
        options,
      );
    },
    history: options.history,
    navigate(url) {
      if (
        options.backendOrigin === undefined ||
        options.navigate === undefined
      ) {
        throw new Error("recovery navigation unavailable");
      }
      options.navigate(url);
    },
    route: options.route,
  });
  if (prepared.status === "rejected") return prepared;
  if (prepared.status === "confirmation_required") {
    // A different browser, an expired flow, or a consumed flow must not burn the
    // mailed token merely to discover that the originating verifier is absent.
    if (options.flows.check === undefined)
      return rejected("recovery_flow_unavailable");
    const url = new URL(callbackUrl);
    try {
      if (
        !(await options.flows.check(
          url.searchParams.get("flow")!,
          url.searchParams.get("state")!,
        ))
      ) {
        return rejected("recovery_flow_invalid");
      }
    } catch {
      return rejected("recovery_flow_unavailable");
    }
    return prepared.confirm();
  }
  const exchangeReceipt = await prepared.exchange();
  return flowReceipt ?? exchangeReceipt;
}

async function consumeRecoveryFlow(
  authorizationCode: string,
  flowId: string,
  state: string,
  options: {
    readonly clock: { readonly now: () => number };
    readonly exchange: (input: {
      readonly authorizationCode: string;
      readonly verifier: string;
    }) => Promise<void>;
    readonly flows: StaffRecoveryFlowStore;
  },
): Promise<StaffAuthCallbackReceipt> {
  let rawFlow: unknown;
  try {
    rawFlow = await options.flows.consume(flowId);
  } catch {
    return rejected("recovery_flow_unavailable");
  }
  const flow = decodeRecoveryFlow(rawFlow);
  if (flow === null) {
    return rejected("recovery_flow_invalid");
  }
  if (flow.status === "replayed") {
    return rejected("recovery_flow_replayed");
  }
  if (flow.status !== "accepted") {
    return rejected("recovery_flow_invalid");
  }
  let now: number;
  try {
    now = options.clock.now();
  } catch {
    return rejected("recovery_flow_unavailable");
  }
  if (
    !Number.isFinite(now) ||
    now >= flow.expiresAt ||
    flow.expiresAt - now > 300_000
  ) {
    return rejected("recovery_flow_expired");
  }
  if (!constantTimeEqual(state, flow.state)) {
    return rejected("recovery_state_mismatch");
  }
  try {
    await options.exchange({ authorizationCode, verifier: flow.verifier });
  } catch {
    return rejected("token_consumption_unavailable");
  }
  return { code: "accepted", kind: "recovery", status: "accepted" };
}

function decodeRecoveryFlow(
  value: unknown,
): StaffRecoveryFlowConsumeResult | null {
  const record = snapshotRecord(value);
  if (record === null || typeof record.status !== "string") {
    return null;
  }
  if (record.status === "invalid" || record.status === "replayed") {
    return hasExactKeys(record, ["status"]) ? { status: record.status } : null;
  }
  if (
    record.status !== "accepted" ||
    !hasExactKeys(record, ["expiresAt", "state", "status", "verifier"]) ||
    !isBase64Url(record.state, 43) ||
    !isBase64Url(record.verifier, 43) ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt)
  ) {
    return null;
  }
  return {
    expiresAt: record.expiresAt,
    state: record.state,
    status: "accepted",
    verifier: record.verifier,
  };
}

type ExactRecord = Readonly<Record<string, unknown>>;

function snapshotRecord(value: unknown): ExactRecord | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const names = Reflect.ownKeys(descriptors);
    const snapshot: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const name of names) {
      if (typeof name !== "string") {
        return null;
      }
      const descriptor = descriptors[name];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      snapshot[name] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function hasExactKeys(record: ExactRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

async function consumeEmailVerificationCode(
  authorizationCode: string,
  flowId: string,
  options: {
    readonly exchange: (input: {
      readonly authorizationCode: string;
      readonly flowId: string;
    }) => Promise<void>;
  },
): Promise<StaffAuthCallbackReceipt> {
  try {
    await options.exchange({ authorizationCode, flowId });
  } catch {
    return rejected("token_consumption_unavailable");
  }
  return { code: "accepted", kind: "email-verification", status: "accepted" };
}

async function consumeTokenHashCallback(
  callbackUrl: string,
  expectedKind: StaffAuthCallbackKind,
  consume: CallbackConsumer,
  options: {
    readonly history: StaffAuthCallbackHistory;
    readonly route: StaffAuthCallbackRoute;
  },
): Promise<StaffAuthCallbackReceipt> {
  const route = scrubAndParseRoute(callbackUrl, options, true);
  if (route.status === "rejected") return route;
  const { url } = route;
  const fragment = /^#token_hash=([0-9a-f]{56})$/u.exec(url.hash);
  const tokenHash = fragment?.[1];
  if (url.search !== `?auth=${expectedKind}` || tokenHash === undefined) {
    return rejected("malformed_callback");
  }

  try {
    await consume(tokenHash);
  } catch {
    return rejected("token_consumption_unavailable");
  }
  return { code: "accepted", kind: expectedKind, status: "accepted" };
}

function scrubAndParseRoute(
  callbackUrl: string,
  options: {
    readonly history: StaffAuthCallbackHistory;
    readonly route: StaffAuthCallbackRoute;
  },
  allowFragment = false,
):
  | StaffAuthCallbackRejectedReceipt
  | { readonly status: "parsed"; readonly url: URL } {
  const route = parseTrustedRootRoute(options.route);
  try {
    options.history.replaceState(null, "", route?.pathname ?? "/");
  } catch {
    return rejected("invalid_callback");
  }
  if (
    route === null ||
    typeof callbackUrl !== "string" ||
    encodedByteLength(callbackUrl) > 8192 ||
    hasControlText(callbackUrl)
  ) {
    return rejected("invalid_callback");
  }
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return rejected("invalid_callback");
  }
  if (
    url.origin !== route.origin ||
    url.pathname !== "/" ||
    url.username !== "" ||
    url.password !== "" ||
    (!allowFragment && url.hash !== "")
  ) {
    return rejected("invalid_callback");
  }
  return { status: "parsed", url };
}

function parseTrustedOrigin(value: string): string | null {
  if (typeof value !== "string" || hasControlText(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const loopbackHostname =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopbackHostname))
  ) {
    return null;
  }
  return parsed.origin;
}

function parseTrustedRootRoute(
  route: StaffAuthCallbackRoute,
): StaffAuthCallbackRoute | null {
  if (route.pathname !== "/" || hasControlText(route.origin)) {
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
  return { origin: origin.origin, pathname: "/" };
}

function rejected(
  code: StaffAuthCallbackRejectedReceipt["code"],
): StaffAuthCallbackRejectedReceipt {
  return { code, status: "rejected" };
}

function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBase64Url(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isRecoveryVerificationToken(value: string): boolean {
  return /^pkce_[0-9a-f]{56}$/u.test(value);
}

function hasControlText(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
