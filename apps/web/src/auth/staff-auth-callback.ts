export type StaffAuthCallbackKind = "invite" | "recovery";

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
      readonly code:
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
 * Scrubs and consumes one application-root recovery callback. Provider session
 * establishment remains behind the injected adapter boundary.
 */
export function consumeStaffRecoveryCallback(
  callbackUrl: string,
  options: {
    readonly clock: { readonly now: () => number };
    readonly exchange: (input: {
      readonly authorizationCode: string;
      readonly verifier: string;
    }) => Promise<void>;
    readonly history: StaffAuthCallbackHistory;
    readonly route: StaffAuthCallbackRoute;
    readonly flows: StaffRecoveryFlowStore;
  },
): Promise<StaffAuthCallbackReceipt> {
  const route = scrubAndParseRoute(callbackUrl, options);
  if (route.status === "rejected") {
    return Promise.resolve(route);
  }
  const url = route.url;
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 4 ||
    url.searchParams.getAll("auth").length !== 1 ||
    url.searchParams.getAll("code").length !== 1 ||
    url.searchParams.getAll("flow").length !== 1 ||
    url.searchParams.getAll("state").length !== 1 ||
    entries.some(
      ([key]) =>
        key !== "auth" && key !== "code" && key !== "flow" && key !== "state",
    ) ||
    url.searchParams.get("auth") !== "recovery"
  ) {
    return Promise.resolve(rejected("malformed_callback"));
  }
  const authorizationCode = url.searchParams.get("code");
  const flowId = url.searchParams.get("flow");
  const state = url.searchParams.get("state");
  if (
    authorizationCode === null ||
    authorizationCode.length === 0 ||
    authorizationCode !== authorizationCode.trim() ||
    encodedByteLength(authorizationCode) > 2048 ||
    hasControlText(authorizationCode) ||
    !isBase64Url(flowId, 22) ||
    !isBase64Url(state, 43)
  ) {
    return Promise.resolve(rejected("malformed_callback"));
  }
  return consumeRecoveryFlow(authorizationCode, flowId, state, options);
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

async function consumeTokenHashCallback(
  callbackUrl: string,
  expectedKind: StaffAuthCallbackKind,
  consume: CallbackConsumer,
  options: {
    readonly history: StaffAuthCallbackHistory;
    readonly route: StaffAuthCallbackRoute;
  },
): Promise<StaffAuthCallbackReceipt> {
  const route = scrubAndParseRoute(callbackUrl, options);
  if (route.status === "rejected") {
    return route;
  }
  const url = route.url;

  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 2 ||
    url.searchParams.getAll("auth").length !== 1 ||
    url.searchParams.getAll("token_hash").length !== 1 ||
    entries.some(([key]) => key !== "auth" && key !== "token_hash")
  ) {
    return rejected("malformed_callback");
  }

  const kind = url.searchParams.get("auth");
  const tokenHash = url.searchParams.get("token_hash");
  if (
    kind !== expectedKind ||
    tokenHash === null ||
    !/^[0-9a-f]{56}$/.test(tokenHash)
  ) {
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
    url.hash !== ""
  ) {
    return rejected("invalid_callback");
  }
  return { status: "parsed", url };
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
  code: Exclude<StaffAuthCallbackReceipt["code"], "accepted">,
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

function constantTimeEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function hasControlText(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}
