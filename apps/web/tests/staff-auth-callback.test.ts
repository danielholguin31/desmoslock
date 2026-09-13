import { describe, expect, it, vi } from "vitest";

import {
  consumeStaffEmailVerificationCallback,
  consumeStaffInvitationCallback,
  prepareStaffEmailVerificationCallback,
  prepareStaffRecoveryCallback,
} from "../src/auth/staff-auth-callback.js";

const origin = "https://app.example.test";
const route = { origin, pathname: "/" } as const;
const flowId = "f".repeat(22);
const state = "s".repeat(43);
const tokenHash = "a".repeat(56);
const sdkFlowId = "0123456789abcdef0123456789abcdef";
const backendOrigin = "https://project.supabase.co";

function history(order: string[] = []) {
  return {
    replaceState(_data: null, _unused: string, url: string) {
      order.push(`scrub:${url}`);
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
      `${origin}/?auth=invite#token_hash=${tokenHash}`,
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
    ["query token", `${origin}/?auth=invite&token_hash=${tokenHash}`],
    [
      "mixed query and fragment",
      `${origin}/?auth=invite&token_hash=${tokenHash}#token_hash=${tokenHash}`,
    ],
    [
      "encoded fragment key",
      `${origin}/?auth=invite#token%5fhash=${tokenHash}`,
    ],
    [
      "encoded hash",
      `${origin}/?auth=invite#token_hash=%61${tokenHash.slice(1)}`,
    ],
    ["legacy token", `${origin}/?auth=invite&token=${tokenHash}`],
    [
      "legacy provider verify",
      `${origin}/auth/v1/verify?token_hash=${tokenHash}&type=invite`,
    ],
    ["wrong kind", `${origin}/?auth=recovery&token_hash=${tokenHash}`],
    [
      "duplicate auth",
      `${origin}/?auth=invite&auth=invite#token_hash=${tokenHash}`,
    ],
    [
      "duplicate hash",
      `${origin}/?auth=invite#token_hash=${tokenHash}&token_hash=${tokenHash}`,
    ],
    [
      "extra key",
      `${origin}/?auth=invite#token_hash=${tokenHash}&next=/school`,
    ],
    ["mixed recovery", `${origin}/?auth=invite#token_hash=${tokenHash}&code=x`],
    ["missing hash", `${origin}/?auth=invite`],
    ["blank hash", `${origin}/?auth=invite#token_hash=`],
    ["short hash", `${origin}/?auth=invite#token_hash=${"a".repeat(55)}`],
    ["long hash", `${origin}/?auth=invite#token_hash=${"a".repeat(57)}`],
    ["uppercase hash", `${origin}/?auth=invite#token_hash=${"A".repeat(56)}`],
    ["non-hex hash", `${origin}/?auth=invite#token_hash=${"g".repeat(56)}`],
    ["whitespace hash", `${origin}/?auth=invite#token_hash=%20${tokenHash}`],
    ["control hash", `${origin}/?auth=invite#token_hash=%00${tokenHash}`],
    [
      "wrong path",
      `${origin}/auth/invitation?auth=invite#token_hash=${tokenHash}`,
    ],
    [
      "wrong origin",
      `https://evil.example/?auth=invite#token_hash=${tokenHash}`,
    ],
    ["fragment", `${origin}/?auth=invite#token_hash=${tokenHash}#secret`],
    ["oversize hash", `${origin}/?auth=invite#token_hash=${"a".repeat(4097)}`],
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
        `${origin}/?auth=invite#token_hash=${tokenHash}`,
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
        `${origin}/?auth=invite#token_hash=${tokenHash}`,
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

describe("mailed signup confirmation", () => {
  const token = `pkce_${tokenHash}`;
  const firstHop = `${origin}/?auth=email-verification&sb_flow_id=${sdkFlowId}#token_hash=${token}&type=signup`;

  it("scrubs an inert link and navigates only once after explicit confirmation", async () => {
    const order: string[] = [];
    const exchange = vi.fn(async () => undefined);
    const navigate = vi.fn();
    const prepared = prepareStaffEmailVerificationCallback(firstHop, {
      backendOrigin,
      exchange,
      history: history(order),
      navigate,
      route,
    });
    expect(order).toEqual(["scrub:/"]);
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
    expect(JSON.stringify(prepared)).not.toContain(token);
    expect(JSON.stringify(prepared)).not.toContain(sdkFlowId);
    expect(prepared.status).toBe("confirmation_required");
    if (prepared.status !== "confirmation_required")
      throw new Error("missing confirmation");
    await expect(prepared.confirm()).resolves.toEqual({
      code: "email_verification_started",
      status: "redirecting",
    });
    expect(navigate).toHaveBeenCalledOnce();
    const expected = new URL("/auth/v1/verify", backendOrigin);
    expected.searchParams.set("token", token);
    expected.searchParams.set("type", "signup");
    expected.searchParams.set(
      "redirect_to",
      `${origin}/?auth=email-verification&sb_flow_id=${sdkFlowId}`,
    );
    expect(navigate).toHaveBeenCalledWith(expected.href);
    await expect(prepared.confirm()).resolves.toEqual({
      code: "callback_already_used",
      status: "rejected",
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    ["foreign origin", firstHop.replace(origin, "https://foreign.example")],
    ["credentials", firstHop.replace("https://", "https://user@")],
    ["wrong path", firstHop.replace("/?auth", "/callback?auth")],
    [
      "direct provider link",
      `${backendOrigin}/auth/v1/verify?token=${token}&type=signup`,
    ],
    ["non-PKCE token", firstHop.replace(token, tokenHash)],
    ["encoded token", firstHop.replace(token, `%70${token.slice(1)}`)],
    ["duplicate token", `${firstHop}&token_hash=${token}`],
    ["duplicate type", `${firstHop}&type=signup`],
    ["wrong type", firstHop.replace("type=signup", "type=recovery")],
    ["query token", firstHop.replace("#token_hash", "&token_hash")],
    ["encoded auth", firstHop.replace("auth=", "a%75th=")],
    ["encoded flow", firstHop.replace("sb_flow_id=", "sb%5fflow_id=")],
    [
      "duplicate auth",
      firstHop.replace("&sb_flow_id", "&auth=email-verification&sb_flow_id"),
    ],
    [
      "duplicate flow",
      firstHop.replace("#token_hash", `&sb_flow_id=${sdkFlowId}#token_hash`),
    ],
    ["missing flow", firstHop.replace(`&sb_flow_id=${sdkFlowId}`, "")],
    ["short flow", firstHop.replace(sdkFlowId, "short")],
    ["mixed code", firstHop.replace("#token_hash", "&code=code#token_hash")],
    [
      "unknown routing",
      firstHop.replace("#token_hash", "&next=/school#token_hash"),
    ],
    ["unknown fragment", `${firstHop}&next=/school`],
    [
      "empty fragment",
      `${origin}/?auth=email-verification&sb_flow_id=${sdkFlowId}&code=code#`,
    ],
  ])(
    "rejects %s without navigation or exchange",
    async (_label, callbackUrl) => {
      const order: string[] = [];
      const navigate = vi.fn();
      const exchange = vi.fn(async () => undefined);
      const prepared = prepareStaffEmailVerificationCallback(callbackUrl, {
        backendOrigin,
        exchange,
        history: history(order),
        navigate,
        route,
      });
      expect(order).toEqual(["scrub:/"]);
      expect(prepared.status).toBe("rejected");
      expect(navigate).not.toHaveBeenCalled();
      expect(exchange).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    "https://user@project.supabase.co",
    "https://project.supabase.co/path",
    "https://project.supabase.co?x=1",
    "https://project.supabase.co#x",
    "http://project.supabase.co",
  ])(
    "rejects an absent or noncanonical provider origin %s",
    (configuredOrigin) => {
      const navigate = vi.fn();
      expect(
        prepareStaffEmailVerificationCallback(firstHop, {
          ...(configuredOrigin === undefined
            ? {}
            : { backendOrigin: configuredOrigin }),
          exchange: vi.fn(),
          history: history(),
          navigate,
          route,
        }).status,
      ).toBe("rejected");
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("requires a navigation boundary and consumes a failed confirmation without leaking it", async () => {
    expect(
      prepareStaffEmailVerificationCallback(firstHop, {
        backendOrigin,
        exchange: vi.fn(),
        history: history(),
        route,
      }).status,
    ).toBe("rejected");
    const navigate = vi.fn(() => {
      throw new Error(token);
    });
    const prepared = prepareStaffEmailVerificationCallback(firstHop, {
      backendOrigin,
      exchange: vi.fn(),
      history: history(),
      navigate,
      route,
    });
    if (prepared.status !== "confirmation_required")
      throw new Error("missing confirmation");
    await expect(prepared.confirm()).resolves.toEqual({
      code: "token_consumption_unavailable",
      status: "rejected",
    });
    await expect(prepared.confirm()).resolves.toEqual({
      code: "callback_already_used",
      status: "rejected",
    });
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("keeps the returned opaque code and SDK flow bound to one explicit exchange", async () => {
    const code = "opaque+code/with=padding";
    const exchange = vi.fn(async () => undefined);
    const navigate = vi.fn();
    const prepared = prepareStaffEmailVerificationCallback(
      `${origin}/?auth=email-verification&sb_flow_id=${sdkFlowId}&code=${encodeURIComponent(code)}`,
      {
        backendOrigin,
        exchange,
        history: history(),
        navigate,
        route,
      },
    );
    expect(exchange).not.toHaveBeenCalled();
    if (prepared.status !== "exchange_required")
      throw new Error("missing exchange");
    expect(JSON.stringify(prepared)).not.toContain(code);
    await expect(prepared.exchange()).resolves.toMatchObject({
      status: "accepted",
    });
    expect(exchange).toHaveBeenCalledExactlyOnceWith({
      authorizationCode: code,
      flowId: sdkFlowId,
    });
    await expect(prepared.exchange()).resolves.toMatchObject({
      code: "callback_already_used",
    });
    expect(exchange).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("staff recovery callback", () => {
  const recoveryToken = `pkce_${tokenHash}`;
  const firstHop = `${origin}/?auth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=recovery`;

  it("prepares an inert first hop whose one explicit command navigates to the exact provider verification URL", async () => {
    const order: string[] = [];
    const navigate = vi.fn((url: string) => {
      order.push(`navigate:${url}`);
    });
    const exchange = vi.fn(async () => undefined);

    const prepared = prepareStaffRecoveryCallback(firstHop, {
      backendOrigin,
      exchange,
      history: history(order),
      navigate,
      route,
    });

    expect(order).toEqual(["scrub:/"]);
    expect(prepared.status).toBe("confirmation_required");
    expect(JSON.stringify(prepared)).not.toContain(recoveryToken);
    expect(JSON.stringify(prepared)).not.toContain(flowId);
    expect(JSON.stringify(prepared)).not.toContain(state);
    expect(exchange).not.toHaveBeenCalled();

    if (prepared.status !== "confirmation_required") {
      throw new Error("expected an inert recovery first hop");
    }
    await expect(prepared.confirm()).resolves.toEqual({
      code: "recovery_verification_started",
      status: "redirecting",
    });
    expect(navigate).toHaveBeenCalledWith(
      `${backendOrigin}/auth/v1/verify?token=${recoveryToken}&type=recovery&redirect_to=https%3A%2F%2Fapp.example.test%2F%3Fauth%3Drecovery%26flow%3D${flowId}%26state%3D${state}`,
    );
  });

  it("prepares the scrubbed provider return as a one-shot Edge exchange", async () => {
    const authorizationCode = "synthetic-provider-authorization-code";
    const order: string[] = [];
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exchange = vi.fn(async (input) => {
      order.push(
        `exchange:${input.authorizationCode}:${input.flowId}:${input.state}`,
      );
      await blocked;
    });
    const prepared = prepareStaffRecoveryCallback(
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=${authorizationCode}`,
      {
        backendOrigin,
        exchange,
        history: history(order),
        navigate: vi.fn(),
        route,
      },
    );

    expect(order).toEqual(["scrub:/"]);
    expect(prepared.status).toBe("exchange_required");
    expect(JSON.stringify(prepared)).not.toContain(authorizationCode);
    expect(JSON.stringify(prepared)).not.toContain(flowId);
    expect(JSON.stringify(prepared)).not.toContain(state);
    expect(exchange).not.toHaveBeenCalled();
    if (prepared.status !== "exchange_required") {
      throw new Error("expected a recovery exchange command");
    }

    const first = prepared.exchange();
    await expect(prepared.exchange()).resolves.toEqual({
      code: "callback_already_used",
      status: "rejected",
    });
    expect(order).toEqual([
      "scrub:/",
      `exchange:${authorizationCode}:${flowId}:${state}`,
    ]);
    expect(exchange).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toEqual({
      code: "accepted",
      kind: "recovery",
      status: "accepted",
    });
  });

  it.each([
    [
      "empty fragment delimiter",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=provider-code#`,
    ],
    [
      "trailing query separator",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=provider-code&`,
    ],
  ])("rejects a provider return with a normalized-away %s", (_label, url) => {
    const exchange = vi.fn(async () => undefined);
    const prepared = prepareStaffRecoveryCallback(url, {
      backendOrigin,
      exchange,
      history: history(),
      navigate: vi.fn(),
      route,
    });

    expect(prepared).toEqual({
      code: "malformed_callback",
      status: "rejected",
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing fragment",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}`,
    ],
    [
      "missing token hash",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#type=recovery`,
    ],
    [
      "missing recovery type",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}`,
    ],
    [
      "reordered query",
      `${origin}/?flow=${flowId}&auth=recovery&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "reordered fragment",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#type=recovery&token_hash=${recoveryToken}`,
    ],
    [
      "duplicate auth",
      `${origin}/?auth=recovery&auth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "duplicate flow",
      `${origin}/?auth=recovery&flow=${flowId}&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "duplicate state",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "duplicate token hash",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "duplicate recovery type",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=recovery&type=recovery`,
    ],
    [
      "extra query field",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&next=/#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "extra fragment field",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=recovery&next=/`,
    ],
    [
      "provider return mixed into first hop",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=provider-code#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "wrong auth kind",
      `${origin}/?auth=invite&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "wrong fragment type",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=signup`,
    ],
    [
      "short flow ID",
      `${origin}/?auth=recovery&flow=${"f".repeat(21)}&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "non-base64url flow ID",
      `${origin}/?auth=recovery&flow=${"!".repeat(22)}&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "short state",
      `${origin}/?auth=recovery&flow=${flowId}&state=${"s".repeat(42)}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "non-base64url state",
      `${origin}/?auth=recovery&flow=${flowId}&state=${"!".repeat(43)}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "short token hash",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#token_hash=pkce_${"a".repeat(55)}&type=recovery`,
    ],
    [
      "uppercase token hash",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#token_hash=pkce_${"A".repeat(56)}&type=recovery`,
    ],
    [
      "non-hex token hash",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#token_hash=pkce_${"g".repeat(56)}&type=recovery`,
    ],
    [
      "unprefixed token hash",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}#token_hash=${tokenHash}&type=recovery`,
    ],
    [
      "encoded field name",
      `${origin}/?%61uth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "wrong path",
      `${origin}/auth/callback?auth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "wrong origin",
      `https://elsewhere.example.test/?auth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
    [
      "userinfo",
      `https://user@app.example.test/?auth=recovery&flow=${flowId}&state=${state}#token_hash=${recoveryToken}&type=recovery`,
    ],
  ])("scrubs and rejects a malformed first hop: %s", (_label, url) => {
    const order: string[] = [];
    const navigate = vi.fn();
    const exchange = vi.fn(async () => undefined);
    const prepared = prepareStaffRecoveryCallback(url, {
      backendOrigin,
      exchange,
      history: history(order),
      navigate,
      route,
    });

    expect(order).toEqual(["scrub:/"]);
    expect(prepared.status).toBe("rejected");
    expect(navigate).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    ["missing code", `${origin}/?auth=recovery&flow=${flowId}&state=${state}`],
    [
      "blank code",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=`,
    ],
    [
      "encoded flow key alias",
      `${origin}/?auth=recovery&code=provider-code&fl%6fw=${flowId}&state=${state}`,
    ],
    [
      "duplicate auth",
      `${origin}/?auth=recovery&auth=recovery&flow=${flowId}&state=${state}&code=provider-code`,
    ],
    [
      "duplicate flow",
      `${origin}/?auth=recovery&flow=${flowId}&flow=${flowId}&state=${state}&code=provider-code`,
    ],
    [
      "duplicate state",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&state=${state}&code=provider-code`,
    ],
    [
      "duplicate code",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=provider-code&code=provider-code`,
    ],
    [
      "extra field",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=provider-code&next=/`,
    ],
    [
      "wrong auth kind",
      `${origin}/?auth=invite&flow=${flowId}&state=${state}&code=provider-code`,
    ],
    [
      "short flow ID",
      `${origin}/?auth=recovery&flow=${"f".repeat(21)}&state=${state}&code=provider-code`,
    ],
    [
      "short state",
      `${origin}/?auth=recovery&flow=${flowId}&state=${"s".repeat(42)}&code=provider-code`,
    ],
    [
      "leading whitespace in code",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=%20provider-code`,
    ],
    [
      "control text in code",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=provider%00code`,
    ],
    [
      "oversize code",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=${"x".repeat(2049)}`,
    ],
    [
      "nonempty fragment",
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=provider-code#unexpected`,
    ],
    [
      "wrong path",
      `${origin}/auth/callback?auth=recovery&flow=${flowId}&state=${state}&code=provider-code`,
    ],
    [
      "wrong origin",
      `https://elsewhere.example.test/?auth=recovery&flow=${flowId}&state=${state}&code=provider-code`,
    ],
  ])("scrubs and rejects a malformed provider return: %s", (_label, url) => {
    const order: string[] = [];
    const navigate = vi.fn();
    const exchange = vi.fn(async () => undefined);
    const prepared = prepareStaffRecoveryCallback(url, {
      backendOrigin,
      exchange,
      history: history(order),
      navigate,
      route,
    });

    expect(order).toEqual(["scrub:/"]);
    expect(prepared.status).toBe("rejected");
    expect(navigate).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    ["insecure remote origin", "http://project.supabase.co"],
    ["path", `${backendOrigin}/auth/v1`],
    ["trailing slash", `${backendOrigin}/`],
    ["query", `${backendOrigin}?project=other`],
    ["fragment", `${backendOrigin}#other`],
    ["userinfo", "https://user@project.supabase.co"],
    ["non-HTTP scheme", "javascript:alert(1)"],
  ])("rejects a noncanonical backend origin: %s", (_label, invalidOrigin) => {
    const navigate = vi.fn();
    const prepared = prepareStaffRecoveryCallback(firstHop, {
      backendOrigin: invalidOrigin,
      exchange: vi.fn(async () => undefined),
      history: history(),
      navigate,
      route,
    });

    expect(prepared).toEqual({
      code: "invalid_callback",
      status: "rejected",
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("allows an exact loopback backend origin for local source verification", async () => {
    const navigate = vi.fn();
    const prepared = prepareStaffRecoveryCallback(firstHop, {
      backendOrigin: "http://127.0.0.1:54321",
      exchange: vi.fn(async () => undefined),
      history: history(),
      navigate,
      route,
    });
    if (prepared.status !== "confirmation_required") {
      throw new Error("expected an inert recovery first hop");
    }

    await prepared.confirm();
    expect(navigate).toHaveBeenCalledWith(
      expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:54321\/auth\/v1\/verify\?/u,
      ),
    );
  });

  it("pins the validated app origin before the explicit command", async () => {
    const mutableRoute: { origin: string; pathname: "/" } = {
      origin,
      pathname: "/",
    };
    const navigate = vi.fn();
    const prepared = prepareStaffRecoveryCallback(firstHop, {
      backendOrigin,
      exchange: vi.fn(async () => undefined),
      history: history(),
      navigate,
      route: mutableRoute,
    });
    mutableRoute.origin = "https://elsewhere.example.test";
    if (prepared.status !== "confirmation_required") {
      throw new Error("expected an inert recovery first hop");
    }

    await prepared.confirm();
    const destination = new URL(String(navigate.mock.calls[0]?.[0]));
    expect(destination.searchParams.get("redirect_to")).toBe(
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}`,
    );
  });

  it("burns the first-hop command before navigation and sanitizes failures", async () => {
    const navigate = vi.fn(() => {
      throw new Error(`navigation leaked ${recoveryToken}`);
    });
    const prepared = prepareStaffRecoveryCallback(firstHop, {
      backendOrigin,
      exchange: vi.fn(async () => undefined),
      history: history(),
      navigate,
      route,
    });
    if (prepared.status !== "confirmation_required") {
      throw new Error("expected an inert recovery first hop");
    }

    const receipt = await prepared.confirm();
    expect(receipt).toEqual({
      code: "token_consumption_unavailable",
      status: "rejected",
    });
    expect(JSON.stringify(receipt)).not.toContain(recoveryToken);
    await expect(prepared.confirm()).resolves.toEqual({
      code: "callback_already_used",
      status: "rejected",
    });
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("burns the provider-return command before exchange and sanitizes failures", async () => {
    const authorizationCode = "synthetic-provider-authorization-code";
    const exchange = vi.fn(async () => {
      throw new Error(
        `exchange leaked ${authorizationCode} ${flowId} ${state}`,
      );
    });
    const prepared = prepareStaffRecoveryCallback(
      `${origin}/?auth=recovery&flow=${flowId}&state=${state}&code=${authorizationCode}`,
      {
        backendOrigin,
        exchange,
        history: history(),
        navigate: vi.fn(),
        route,
      },
    );
    if (prepared.status !== "exchange_required") {
      throw new Error("expected a recovery exchange command");
    }

    const receipt = await prepared.exchange();
    expect(receipt).toEqual({
      code: "token_consumption_unavailable",
      status: "rejected",
    });
    expect(JSON.stringify(receipt)).not.toContain(authorizationCode);
    expect(JSON.stringify(receipt)).not.toContain(flowId);
    expect(JSON.stringify(receipt)).not.toContain(state);
    await expect(prepared.exchange()).resolves.toEqual({
      code: "callback_already_used",
      status: "rejected",
    });
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("fails closed if the defense-in-depth history scrub fails", () => {
    const navigate = vi.fn();
    const exchange = vi.fn(async () => undefined);
    const prepared = prepareStaffRecoveryCallback(firstHop, {
      backendOrigin,
      exchange,
      history: {
        replaceState() {
          throw new Error(`history leaked ${recoveryToken}`);
        },
      },
      navigate,
      route,
    });

    expect(prepared).toEqual({
      code: "invalid_callback",
      status: "rejected",
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });
});

describe("provider recovery query serialization", () => {
  it("accepts GoTrue's sorted callback keys without weakening credential scrubbing", async () => {
    const order: string[] = [];
    const exchange = vi.fn(async () => undefined);
    const navigate = vi.fn();
    const prepared = prepareStaffRecoveryCallback(
      `${origin}/?auth=recovery&code=provider-code&flow=${flowId}&state=${state}`,
      { backendOrigin, exchange, history: history(order), navigate, route },
    );
    expect(order).toEqual(["scrub:/"]);
    expect(exchange).not.toHaveBeenCalled();
    expect(prepared.status).toBe("exchange_required");
    if (prepared.status !== "exchange_required")
      throw new Error("expected exchange");
    await prepared.exchange();
    expect(exchange).toHaveBeenCalledExactlyOnceWith({
      authorizationCode: "provider-code",
      flowId,
      state,
    });
    expect(navigate).not.toHaveBeenCalled();
  });
});
