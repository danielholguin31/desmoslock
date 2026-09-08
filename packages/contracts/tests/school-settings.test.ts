import { describe, expect, it, vi } from "vitest";

import {
  parseSchoolDisplayName,
  parseSchoolSettings,
  parseUpdateSchoolDisplayNameRequest,
  parseUpdateSchoolDisplayNameRpcResult,
  updateSchoolDisplayNameRpcFailureCodes,
  updateSchoolDisplayNameRpcSuccessCodes,
  validateSchoolDisplayNameDraft,
} from "../src/index.js";

const schoolId = "10000000-0000-4000-8000-000000000001";
const settings = {
  schoolId,
  displayName: "Example School",
  settingsRevision: 3,
};
const request = {
  schoolId,
  displayName: "Example School",
  expectedSettingsRevision: 3,
};

describe("School display-name validation", () => {
  it.each([
    "Example School",
    "École du Nord",
    "e\u0301cole",
    "学校",
    "🦉 Academy",
    "A\u200dB",
  ])(
    "preserves canonical Unicode name %s without normalization",
    (displayName) => {
      expect(parseSchoolDisplayName(displayName)).toBe(displayName);
      expect(validateSchoolDisplayNameDraft(displayName)).toEqual({
        ok: true,
        displayName,
      });
    },
  );

  it.each([
    " ",
    "\u00a0",
    "\u1680",
    "\u2000",
    "\u2028",
    "\u2029",
    "\u202f",
    "\u205f",
    "\u3000",
    "\ufeff",
  ])(
    "trims surrounding whitespace in drafts but rejects it on the wire: %j",
    (whitespace) => {
      const draft = `${whitespace}Example School${whitespace}`;
      expect(validateSchoolDisplayNameDraft(draft)).toEqual({
        ok: true,
        displayName: "Example School",
      });
      expect(parseSchoolDisplayName(draft)).toBeNull();
      expect(validateSchoolDisplayNameDraft(whitespace)).toEqual({
        ok: false,
        reason: "required",
      });
    },
  );

  it.each(["", "   ", "\u00a0\u3000"])(
    "rejects an empty canonical draft %j",
    (value) => {
      expect(validateSchoolDisplayNameDraft(value)).toEqual({
        ok: false,
        reason: "required",
      });
      expect(parseSchoolDisplayName(value)).toBeNull();
    },
  );

  it.each(["\u0000", "\t", "\n", "\r", "\u001f", "\u007f", "\u0085", "\u009f"])(
    "rejects raw control characters before trimming or byte checks: %j",
    (control) => {
      for (const value of [
        ` ${control} `,
        `${control}School`,
        `School${control}`,
        `A${control}B`,
        `${"x".repeat(161)}${control}`,
      ]) {
        expect(validateSchoolDisplayNameDraft(value)).toEqual({
          ok: false,
          reason: "invalid_characters",
        });
        expect(parseSchoolDisplayName(value)).toBeNull();
      }
    },
  );

  it.each([
    "\ud800",
    "\udfff",
    "A\ud800B",
    "\udc00\ud800",
    `${"x".repeat(161)}\ud800`,
  ])(
    "rejects ill-formed UTF-16 instead of validating repaired UTF-8: %j",
    (value) => {
      expect(validateSchoolDisplayNameDraft(value)).toEqual({
        ok: false,
        reason: "invalid_characters",
      });
      expect(parseSchoolDisplayName(value)).toBeNull();
    },
  );

  it.each([
    ["x", 160],
    ["é", 80],
    ["🦉", 40],
  ] as const)(
    "bounds %s names by UTF-8 bytes rather than characters",
    (character, maximum) => {
      const exact = character.repeat(maximum);
      expect(parseSchoolDisplayName(exact)).toBe(exact);
      expect(validateSchoolDisplayNameDraft(` ${exact} `)).toEqual({
        ok: true,
        displayName: exact,
      });
      expect(
        validateSchoolDisplayNameDraft(character.repeat(maximum + 1)),
      ).toEqual({ ok: false, reason: "too_long" });
      expect(parseSchoolDisplayName(character.repeat(maximum + 1))).toBeNull();
    },
  );

  it("does not coerce non-string wire names", () => {
    const coerce = vi.fn(() => "School");
    for (const value of [
      null,
      undefined,
      true,
      1,
      1n,
      ["School"],
      { toString: coerce },
    ]) {
      expect(parseSchoolDisplayName(value)).toBeNull();
    }
    expect(coerce).not.toHaveBeenCalled();
  });
});

describe.each([
  {
    name: "School settings",
    parse: parseSchoolSettings,
    value: settings,
    revisionKey: "settingsRevision",
  },
  {
    name: "display-name update",
    parse: parseUpdateSchoolDisplayNameRequest,
    value: request,
    revisionKey: "expectedSettingsRevision",
  },
])("$name exact contract", ({ parse, value, revisionKey }) => {
  it("accepts canonical identity/name and positive safe revisions", () => {
    expect(parse(value)).toEqual(value);
    for (const revision of [1, Number.MAX_SAFE_INTEGER]) {
      expect(parse({ ...value, [revisionKey]: revision })).toEqual({
        ...value,
        [revisionKey]: revision,
      });
    }
    expect(parse(Object.assign(Object.create(null) as object, value))).toEqual(
      value,
    );
  });

  it.each([
    0,
    -1,
    1.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "3",
    3n,
    true,
    null,
    undefined,
  ])("rejects a missing, nonnumeric or unsafe revision %s", (revision) => {
    expect(parse({ ...value, [revisionKey]: revision })).toBeNull();
  });

  it.each([
    "not-a-school",
    "10000000-0000-0000-8000-000000000001",
    "10000000-0000-4000-0000-000000000001",
    "10000000-0000-4000-8000-00000000000A",
    `${schoolId} `,
  ])("rejects noncanonical School identity %s", (invalidSchoolId) => {
    expect(parse({ ...value, schoolId: invalidSchoolId })).toBeNull();
  });

  it.each([" School", "School ", "School\n", "x".repeat(161), "\ud800", null])(
    "requires an already canonical name %j",
    (displayName) => {
      expect(parse({ ...value, displayName })).toBeNull();
    },
  );

  it("rejects omissions and extra caller authority or response fields", () => {
    for (const key of Object.keys(value)) {
      expect(
        parse(
          Object.fromEntries(
            Object.entries(value).filter(([name]) => name !== key),
          ),
        ),
      ).toBeNull();
    }
    for (const extra of [
      { role: "owner" },
      { workspaceId: schoolId },
      { revision: 3 },
      { ok: true },
      { [Symbol("extra")]: true },
    ]) {
      expect(parse({ ...value, ...extra })).toBeNull();
    }
  });

  it("rejects inherited authority and accessor properties without executing them", () => {
    const inherited = Object.create(value) as object;
    expect(parse(inherited)).toBeNull();
    expect(
      parse(Object.assign(Object.create({ role: "owner" }) as object, value)),
    ).toBeNull();
    let reads = 0;
    const accessor = { ...value };
    Object.defineProperty(accessor, revisionKey, {
      enumerable: true,
      get() {
        reads += 1;
        return 3;
      },
    });
    expect(parse(accessor)).toBeNull();
    expect(reads).toBe(0);
    const nonenumerable = { ...value };
    Object.defineProperty(nonenumerable, revisionKey, {
      enumerable: false,
      value: 3,
    });
    expect(parse(nonenumerable)).toBeNull();
  });

  it("snapshots descriptor values without reading Proxy getters or retaining input", () => {
    let reads = 0;
    const source = { ...value };
    const proxy = new Proxy(source, {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const parsed = parse(proxy);
    source.displayName = "Changed afterward";
    expect(parsed).toEqual(value);
    expect(reads).toBe(0);
    const revoked = Proxy.revocable({ ...value }, {});
    revoked.revoke();
    expect(parse(revoked.proxy)).toBeNull();
  });
});

describe("School display-name RPC result", () => {
  it("distinguishes an acknowledged update from an acknowledged no-op", () => {
    expect(updateSchoolDisplayNameRpcSuccessCodes).toEqual([
      "school_display_name_updated",
      "school_display_name_unchanged",
    ]);
    for (const code of updateSchoolDisplayNameRpcSuccessCodes) {
      expect(parseUpdateSchoolDisplayNameRpcResult([{ code }])).toEqual({
        ok: true,
        code,
      });
    }
  });

  it("preserves the closed raw failure vocabulary for authoritative classification", () => {
    expect(updateSchoolDisplayNameRpcFailureCodes).toEqual([
      "school_settings_revision_conflict",
      "email_unverified",
      "forbidden",
      "invalid_request",
      "membership_inactive",
      "session_expired",
      "session_revoked",
      "step_up_required",
      "unauthenticated",
      "dependency_unavailable",
    ]);
    for (const code of updateSchoolDisplayNameRpcFailureCodes) {
      expect(parseUpdateSchoolDisplayNameRpcResult([{ code }])).toEqual({
        ok: false,
        code,
      });
    }
  });

  it.each([
    "ok",
    "unknown",
    "conflict",
    "rate_limited",
    "membership_role_changed",
    "membership_revision_conflict",
    "invitation_created",
    "invitation_expired",
    "service_unavailable",
    "authentication_required",
    "school_display_name_updated ",
    1,
    null,
  ])(
    "does not treat unknown or unrelated code %s as an acknowledgement",
    (code) => {
      expect(parseUpdateSchoolDisplayNameRpcResult([{ code }])).toBeNull();
    },
  );

  it("requires exactly one code-only row without wrapper or presentation data", () => {
    const row = { code: "school_display_name_updated" };
    for (const value of [
      null,
      undefined,
      row,
      [],
      [row, row],
      [{}],
      [{ ...row, ok: true }],
      [{ ...row, display_name: "School" }],
      [{ ...row, settings_revision: 4 }],
      { data: [row], error: null },
      [Object.assign(Object.create({ ok: true }) as object, row)],
      new Array(1),
      { 0: row, length: 1 },
    ]) {
      expect(parseUpdateSchoolDisplayNameRpcResult(value)).toBeNull();
    }
    const extraArray = Object.assign([row], { authority: "owner" });
    expect(parseUpdateSchoolDisplayNameRpcResult(extraArray)).toBeNull();
    expect(
      parseUpdateSchoolDisplayNameRpcResult([
        Object.assign(Object.create(null) as object, row),
      ]),
    ).toEqual({ ok: true, code: "school_display_name_updated" });
  });

  it("does not execute accessor rows or array indices", () => {
    let reads = 0;
    const row = Object.defineProperty({}, "code", {
      enumerable: true,
      get() {
        reads += 1;
        return "school_display_name_updated";
      },
    });
    expect(parseUpdateSchoolDisplayNameRpcResult([row])).toBeNull();
    const rows = Object.defineProperty([null], "0", {
      enumerable: true,
      get() {
        reads += 1;
        return { code: "school_display_name_updated" };
      },
    });
    expect(parseUpdateSchoolDisplayNameRpcResult(rows)).toBeNull();
    expect(reads).toBe(0);
  });

  it("snapshots exact Proxy rows and fails closed on revoked Proxies", () => {
    let reads = 0;
    const source = { code: "school_display_name_unchanged" };
    const row = new Proxy(source, {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const rows = new Proxy([row], {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(parseUpdateSchoolDisplayNameRpcResult(rows)).toEqual({
      ok: true,
      code: "school_display_name_unchanged",
    });
    expect(reads).toBe(0);
    const revokedRow = Proxy.revocable(source, {});
    const revokedRows = Proxy.revocable([source], {});
    revokedRow.revoke();
    revokedRows.revoke();
    expect(
      parseUpdateSchoolDisplayNameRpcResult([revokedRow.proxy]),
    ).toBeNull();
    expect(parseUpdateSchoolDisplayNameRpcResult(revokedRows.proxy)).toBeNull();
  });
});
