import { describe, expect, it, vi } from "vitest";

import {
  consumeStaffEmailVerificationCallback,
  consumeStaffInvitationCallback,
  consumeStaffRecoveryCallback,
  type StaffRecoveryFlowConsumeResult,
  type StaffRecoveryFlowStore,
} from "../src/auth/staff-auth-callback.js";

const origin = "https://app.example.test";
const route = { origin, pathname: "/" } as const;
const flowId = "f".repeat(22);
const state = "s".repeat(43);
const verifier = "v".repeat(43);
const tokenHash = "a".repeat(56);
const sdkFlowId = "0123456789abcdef0123456789abcdef";

function history(order: string[] = []) {
  return {
    replaceState(_data: null, _unused: string, url: string) {
      order.push(`scrub:${url}`);
    },
  };
}

function flowStore(
  result: StaffRecoveryFlowConsumeResult = {
    expiresAt: 301_000,
    state,
    status: "accepted",
    verifier,
  },
): StaffRecoveryFlowStore {
  return {
    async consume() {
      return result;
    },
    async create() {
      return {
        codeChallenge: "c".repeat(43),
        flowId,
        state,
      };
    },
  };
}

describe("staff invitation callback", () => {
  it("scrubs synchronously and exposes a valid hash only to inspection", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = consumeStaffInvitationCallback(
      `${origin}/?token_hash=${tokenHash}&auth=invite`,
      {
        history: history(order),
        async inspect(received) {
          order.push(`inspect:${received}`);
          await blocked;
        },
        route,
      },
    );

    expect(order).toEqual(["scrub:/", `inspect:${tokenHash}`]);
    release();
    const receipt = await work;
    expect(receipt).toEqual({
      code: "accepted",
      kind: "invite",
      status: "accepted",
    });
    expect(JSON.stringify(receipt)).not.toContain(tokenHash);
  });

  it.each([
    ["legacy token", `${origin}/?auth=invite&token=${tokenHash}`],
    [
      "legacy provider verify",
      `${origin}/auth/v1/verify?token_hash=${tokenHash}&type=invite`,
    ],
    ["wrong kind", `${origin}/?auth=recovery&token_hash=${tokenHash}`],
    [
      "duplicate auth",
      `${origin}/?auth=invite&auth=invite&token_hash=${tokenHash}`,
    ],
    [
      "duplicate hash",
      `${origin}/?auth=invite&token_hash=${tokenHash}&token_hash=${tokenHash}`,
    ],
    [
      "extra key",
      `${origin}/?auth=invite&token_hash=${tokenHash}&next=/school`,
    ],
    ["mixed recovery", `${origin}/?auth=invite&token_hash=${tokenHash}&code=x`],
    ["missing hash", `${origin}/?auth=invite`],
    ["blank hash", `${origin}/?auth=invite&token_hash=`],
    ["short hash", `${origin}/?auth=invite&token_hash=${"a".repeat(55)}`],
    ["long hash", `${origin}/?auth=invite&token_hash=${"a".repeat(57)}`],
    ["uppercase hash", `${origin}/?auth=invite&token_hash=${"A".repeat(56)}`],
    ["non-hex hash", `${origin}/?auth=invite&token_hash=${"g".repeat(56)}`],
    ["whitespace hash", `${origin}/?auth=invite&token_hash=%20${tokenHash}`],
    ["control hash", `${origin}/?auth=invite&token_hash=%00${tokenHash}`],
    [
      "wrong path",
      `${origin}/auth/invitation?auth=invite&token_hash=${tokenHash}`,
    ],
    [
      "wrong origin",
      `https://evil.example/?auth=invite&token_hash=${tokenHash}`,
    ],
    ["fragment", `${origin}/?auth=invite&token_hash=${tokenHash}#secret`],
    ["oversize hash", `${origin}/?auth=invite&token_hash=${"a".repeat(4097)}`],
  ])(
    "scrubs and rejects %s without inspection",
    async (_label, callbackUrl) => {
      const scrubs: string[] = [];
      const inspect = vi.fn(async () => undefined);
      const receipt = await consumeStaffInvitationCallback(callbackUrl, {
        history: history(scrubs),
        inspect,
        route,
      });
      expect(scrubs).toEqual(["scrub:/"]);
      expect(receipt.status).toBe("rejected");
      expect(inspect).not.toHaveBeenCalled();
    },
  );

  it("sanitizes inspection and history failures", async () => {
    await expect(
      consumeStaffInvitationCallback(
        `${origin}/?auth=invite&token_hash=${tokenHash}`,
        {
          history: history(),
          inspect: async () => {
            throw new Error(`provider leaked ${tokenHash}`);
          },
          route,
        },
      ),
    ).resolves.toEqual({
      code: "token_consumption_unavailable",
      status: "rejected",
    });

    const inspect = vi.fn(async () => undefined);
    await expect(
      consumeStaffInvitationCallback(
        `${origin}/?auth=invite&token_hash=${tokenHash}`,
        {
          history: {
            replaceState() {
              throw new Error("history unavailable");
            },
          },
          inspect,
          route,
        },
      ),
    ).resolves.toEqual({ code: "invalid_callback", status: "rejected" });
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe("staff email-verification callback", () => {
  const authorizationCode = "synthetic-email-verification-code";
  const callbackUrl = `${origin}/?sb_flow_id=${sdkFlowId}&code=${authorizationCode}&auth=email-verification`;

  it("scrubs synchronously before exchanging the exact SDK-owned verifier slot", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const receipt = consumeStaffEmailVerificationCallback(callbackUrl, {
      async exchange(input) {
        order.push(`exchange:${input.authorizationCode}:${input.flowId}`);
        await blocked;
      },
      history: history(order),
      route,
    });

    expect(order).toEqual([
      "scrub:/",
      `exchange:${authorizationCode}:${sdkFlowId}`,
    ]);
    release();
    await expect(receipt).resolves.toEqual({
      code: "accepted",
      kind: "email-verification",
      status: "accepted",
    });
    expect(JSON.stringify(await receipt)).not.toContain(authorizationCode);
  });

  it.each([
    ["bare code", `${origin}/?code=${authorizationCode}`],
    [
      "missing flow",
      `${origin}/?auth=email-verification&code=${authorizationCode}`,
    ],
    [
      "duplicate flow",
      `${origin}/?auth=email-verification&code=${authorizationCode}&sb_flow_id=${sdkFlowId}&sb_flow_id=${sdkFlowId}`,
    ],
    [
      "duplicate auth",
      `${origin}/?auth=email-verification&auth=email-verification&code=${authorizationCode}&sb_flow_id=${sdkFlowId}`,
    ],
    [
      "extra key",
      `${origin}/?auth=email-verification&code=${authorizationCode}&sb_flow_id=${sdkFlowId}&next=/school`,
    ],
    [
      "mixed recovery",
      `${origin}/?auth=email-verification&code=${authorizationCode}&sb_flow_id=${sdkFlowId}&flow=${flowId}&state=${state}`,
    ],
    [
      "mixed invitation",
      `${origin}/?auth=email-verification&code=${authorizationCode}&sb_flow_id=${sdkFlowId}&token_hash=${tokenHash}`,
    ],
    [
      "wrong auth",
      `${origin}/?auth=recovery&code=${authorizationCode}&sb_flow_id=${sdkFlowId}`,
    ],
    [
      "short flow",
      `${origin}/?auth=email-verification&code=${authorizationCode}&sb_flow_id=short`,
    ],
    [
      "invalid flow",
      `${origin}/?auth=email-verification&code=${authorizationCode}&sb_flow_id=${"!".repeat(32)}`,
    ],
    [
      "oversize code",
      `${origin}/?auth=email-verification&code=${"x".repeat(2049)}&sb_flow_id=${sdkFlowId}`,
    ],
    [
      "wrong path",
      `${origin}/auth/callback?auth=email-verification&code=${authorizationCode}&sb_flow_id=${sdkFlowId}`,
    ],
    [
      "wrong origin",
      `https://evil.example/?auth=email-verification&code=${authorizationCode}&sb_flow_id=${sdkFlowId}`,
    ],
    ["fragment", `${callbackUrl}#credential`],
  ])("scrubs and rejects %s before exchange", async (_label, url) => {
    const order: string[] = [];
    const exchange = vi.fn(async () => undefined);
    const receipt = await consumeStaffEmailVerificationCallback(url, {
      exchange,
      history: history(order),
      route,
    });
    expect(order).toEqual(["scrub:/"]);
    expect(receipt.status).toBe("rejected");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("sanitizes a consumed or missing SDK verifier without retaining credentials", async () => {
    const receipt = await consumeStaffEmailVerificationCallback(callbackUrl, {
      async exchange() {
        throw new Error(`provider leaked ${authorizationCode}`);
      },
      history: history(),
      route,
    });
    expect(receipt).toEqual({
      code: "token_consumption_unavailable",
      status: "rejected",
    });
    expect(JSON.stringify(receipt)).not.toContain(authorizationCode);
    expect(JSON.stringify(receipt)).not.toContain(sdkFlowId);
  });
});

describe("staff recovery callback", () => {
  const callbackUrl = `${origin}/?state=${state}&auth=recovery&code=provider-code&flow=${flowId}`;

  it("scrubs before atomically consuming the flow and exchanges transient credentials", async () => {
    const order: string[] = [];
    const flows = flowStore();
    const consume = vi
      .spyOn(flows, "consume")
      .mockImplementation(async (received) => {
        order.push(`consume:${received}`);
        return { expiresAt: 301_000, state, status: "accepted", verifier };
      });
    const exchange = vi.fn(
      async ({ authorizationCode, verifier: received }) => {
        order.push(`exchange:${authorizationCode}:${received}`);
      },
    );

    const receipt = await consumeStaffRecoveryCallback(callbackUrl, {
      clock: { now: () => 1_000 },
      exchange,
      flows,
      history: history(order),
      route,
    });

    expect(order).toEqual([
      "scrub:/",
      `consume:${flowId}`,
      `exchange:provider-code:${verifier}`,
    ]);
    expect(consume).toHaveBeenCalledOnce();
    expect(receipt).toEqual({
      code: "accepted",
      kind: "recovery",
      status: "accepted",
    });
    expect(JSON.stringify(receipt)).not.toContain("provider-code");
    expect(JSON.stringify(receipt)).not.toContain(verifier);
  });

  it.each([
    ["missing code", `${origin}/?auth=recovery&flow=${flowId}&state=${state}`],
    ["missing state", `${origin}/?auth=recovery&code=x&flow=${flowId}`],
    [
      "duplicate state",
      `${origin}/?auth=recovery&code=x&flow=${flowId}&state=${state}&state=${state}`,
    ],
    [
      "duplicate flow",
      `${origin}/?auth=recovery&code=x&flow=${flowId}&flow=${flowId}&state=${state}`,
    ],
    [
      "extra key",
      `${origin}/?auth=recovery&code=x&flow=${flowId}&state=${state}&next=/`,
    ],
    ["legacy PKCE", `${origin}/?code=x&flow=password_recovery&state=${state}`],
    [
      "mixed token hash",
      `${origin}/?auth=recovery&token_hash=${tokenHash}&code=x&flow=${flowId}&state=${state}`,
    ],
    [
      "invite mix",
      `${origin}/?auth=invite&code=x&flow=${flowId}&state=${state}`,
    ],
    [
      "wrong path",
      `${origin}/auth/callback?auth=recovery&code=x&flow=${flowId}&state=${state}`,
    ],
    ["short flow", `${origin}/?auth=recovery&code=x&flow=short&state=${state}`],
    [
      "short state",
      `${origin}/?auth=recovery&code=x&flow=${flowId}&state=short`,
    ],
    [
      "oversize code",
      `${origin}/?auth=recovery&code=${"x".repeat(2049)}&flow=${flowId}&state=${state}`,
    ],
  ])("scrubs and rejects %s before flow consumption", async (_label, url) => {
    const scrubs: string[] = [];
    const flows = flowStore();
    const consume = vi.spyOn(flows, "consume");
    const exchange = vi.fn(async () => undefined);
    const receipt = await consumeStaffRecoveryCallback(url, {
      clock: { now: () => 1_000 },
      exchange,
      flows,
      history: history(scrubs),
      route,
    });
    expect(scrubs).toEqual(["scrub:/"]);
    expect(receipt.status).toBe("rejected");
    expect(consume).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", { status: "invalid" } as const, "recovery_flow_invalid"],
    ["replayed", { status: "replayed" } as const, "recovery_flow_replayed"],
    [
      "expired",
      { expiresAt: 1_000, state, status: "accepted", verifier } as const,
      "recovery_flow_expired",
    ],
    [
      "too-long lifetime",
      { expiresAt: 301_001, state, status: "accepted", verifier } as const,
      "recovery_flow_expired",
    ],
    [
      "cross-flow state",
      {
        expiresAt: 301_000,
        state: "x".repeat(43),
        status: "accepted",
        verifier,
      } as const,
      "recovery_state_mismatch",
    ],
  ])("rejects a %s one-time flow", async (_label, result, code) => {
    const exchange = vi.fn(async () => undefined);
    const receipt = await consumeStaffRecoveryCallback(callbackUrl, {
      clock: { now: () => 1_000 },
      exchange,
      flows: flowStore(result),
      history: history(),
      route,
    });
    expect(receipt).toEqual({ code, status: "rejected" });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("fails closed on inaccessible flow records and sanitized exchange errors", async () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    const proxyStore = flowStore();
    vi.spyOn(proxyStore, "consume").mockResolvedValue(
      proxy as StaffRecoveryFlowConsumeResult,
    );
    await expect(
      consumeStaffRecoveryCallback(callbackUrl, {
        clock: { now: () => 1_000 },
        exchange: async () => undefined,
        flows: proxyStore,
        history: history(),
        route,
      }),
    ).resolves.toEqual({ code: "recovery_flow_invalid", status: "rejected" });

    const receipt = await consumeStaffRecoveryCallback(callbackUrl, {
      clock: { now: () => 1_000 },
      exchange: async () => {
        throw new Error(`provider leaked ${verifier}`);
      },
      flows: flowStore(),
      history: history(),
      route,
    });
    expect(receipt).toEqual({
      code: "token_consumption_unavailable",
      status: "rejected",
    });
    expect(JSON.stringify(receipt)).not.toContain(verifier);
  });
});
