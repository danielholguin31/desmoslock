import { describe, expect, it, vi } from "vitest";

import {
  parseCreateSchoolTestRequest,
  parseCreateSchoolTestRpcResult,
  parseEndTestRpcResult,
  parseOpenTestRpcResult,
  parseReadSchoolTestRequest,
  parseReadSchoolTestRpcResult,
  parseReadSchoolTestsRequest,
  parseReadSchoolTestsRpcResult,
  parseStaffTest,
  parseTestPageCursor,
  parseTestRevisionRequest,
  parseTestTimestamp,
  parseTestTitle,
  parseUpdateTestTitleRequest,
  parseUpdateTestTitleRpcResult,
  validateTestTitleDraft,
  type StaffTest,
} from "../src/index.js";

const schoolId = "10000000-0000-4000-8000-000000000001";
const foreignSchoolId = "10000000-0000-4000-8000-000000000002";
const testId = "20000000-0000-4000-8000-000000000001";
const profileId = "30000000-0000-4000-8000-000000000001";
const creationRequestId = "40000000-0000-4000-8000-000000000001";
const createdAt = "2026-09-08T10:20:30.123456Z";
const draft: StaffTest = {
  id: testId,
  schoolId,
  createdByProfileId: profileId,
  title: "Algebra quiz",
  lifecycle: "draft",
  revision: 1,
  createdAt,
  openedAt: null,
  endedAt: null,
};
const listRequest = { schoolId, before: null };
const detailRequest = { schoolId, testId };
const revisionRequest = { schoolId, testId, expectedTestRevision: 1 };
const accessFailures = [
  "email_unverified",
  "forbidden",
  "invalid_request",
  "membership_inactive",
  "session_expired",
  "session_revoked",
  "step_up_required",
  "unauthenticated",
  "dependency_unavailable",
];

function sqlRow(test: StaffTest = draft) {
  return {
    code: "ok",
    test_id: test.id,
    school_id: test.schoolId,
    created_by_profile_id: test.createdByProfileId,
    title: test.title,
    lifecycle: test.lifecycle,
    test_revision: test.revision,
    created_at: test.createdAt,
    opened_at: test.openedAt,
    ended_at: test.endedAt,
  };
}

function failureRow(code: string) {
  return {
    code,
    test_id: null,
    school_id: null,
    created_by_profile_id: null,
    title: null,
    lifecycle: null,
    test_revision: null,
    created_at: null,
    opened_at: null,
    ended_at: null,
  };
}

describe("Test title draft and wire validation", () => {
  it.each(["Algebra quiz", "é", "e\u0301", "学校", "🦉 Quiz", "A\u200dB"])(
    "preserves canonical Unicode without normalization: %s",
    (title) => {
      expect(parseTestTitle(title)).toBe(title);
      expect(validateTestTitleDraft(title)).toEqual({ ok: true, title });
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
    "trims only drafts while preserving canonical wire boundaries: %j",
    (space) => {
      expect(validateTestTitleDraft(`${space}Quiz${space}`)).toEqual({
        ok: true,
        title: "Quiz",
      });
      expect(parseTestTitle(`${space}Quiz${space}`)).toBeNull();
      expect(validateTestTitleDraft(space)).toEqual({
        ok: false,
        reason: "required",
      });
    },
  );
  it("rejects all raw C0/C1 controls before trimming or byte validation", () => {
    for (const point of [
      ...Array.from({ length: 32 }, (_, index) => index),
      ...Array.from({ length: 33 }, (_, index) => 127 + index),
    ]) {
      for (const title of [
        ` ${String.fromCodePoint(point)} `,
        `Quiz${String.fromCodePoint(point)}`,
        `${"x".repeat(161)}${String.fromCodePoint(point)}`,
      ]) {
        expect(validateTestTitleDraft(title)).toEqual({
          ok: false,
          reason: "invalid_characters",
        });
        expect(parseTestTitle(title)).toBeNull();
      }
    }
  });
  it.each([
    "\ud800",
    "\udfff",
    "A\ud800B",
    "\udc00\ud800",
    `${"x".repeat(161)}\ud800`,
  ])("rejects unpaired UTF-16 before UTF-8 repair: %j", (value) => {
    expect(validateTestTitleDraft(value)).toEqual({
      ok: false,
      reason: "invalid_characters",
    });
    expect(parseTestTitle(value)).toBeNull();
  });
  it.each([
    ["x", 160],
    ["é", 80],
    ["🦉", 40],
  ] as const)("uses the 160-byte UTF-8 boundary for %s", (character, count) => {
    const title = character.repeat(count);
    expect(parseTestTitle(title)).toBe(title);
    expect(validateTestTitleDraft(` ${title} `)).toEqual({ ok: true, title });
    expect(validateTestTitleDraft(`${title}x`)).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect(parseTestTitle(`${title}x`)).toBeNull();
  });
  it("does not coerce a missing, boxed or arbitrary title", () => {
    const coerce = vi.fn(() => "Quiz");
    for (const value of [
      undefined,
      null,
      1,
      true,
      [],
      { toString: coerce },
      Object("Quiz"),
    ])
      expect(parseTestTitle(value)).toBeNull();
    expect(parseTestTitle("")).toBeNull();
    expect(validateTestTitleDraft("")).toEqual({
      ok: false,
      reason: "required",
    });
    expect(coerce).not.toHaveBeenCalled();
  });
});

describe("exact Test microsecond timestamps", () => {
  it.each([
    "0001-01-01T00:00:00.000000Z",
    "9999-12-31T23:59:59.999999Z",
    "2000-02-29T00:00:00.100000Z",
    "2024-02-29T23:59:59.000001Z",
    "1900-02-28T01:02:03.123456Z",
    "2026-04-30T12:30:45.123999Z",
  ])("retains every byte of valid calendar value %s", (value) => {
    expect(parseTestTimestamp(value)).toBe(value);
  });
  it.each([
    "0000-01-01T00:00:00.000000Z",
    "10000-01-01T00:00:00.000000Z",
    "1900-02-29T00:00:00.000000Z",
    "2100-02-29T00:00:00.000000Z",
    "2025-02-29T00:00:00.000000Z",
    "2026-04-31T00:00:00.000000Z",
    "2026-00-01T00:00:00.000000Z",
    "2026-13-01T00:00:00.000000Z",
    "2026-01-00T00:00:00.000000Z",
    "2026-01-32T00:00:00.000000Z",
    "2026-01-01T24:00:00.000000Z",
    "2026-01-01T00:60:00.000000Z",
    "2026-01-01T00:00:60.000000Z",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.00000Z",
    "2026-01-01T00:00:00.0000000Z",
    "2026-01-01T00:00:00.000000+00:00",
    "2026-01-01T00:00:00.000000z",
    "2026-01-01t00:00:00.000000Z",
    "2026-1-01T00:00:00.000000Z",
    " 2026-01-01T00:00:00.000000Z",
    "2026-01-01T00:00:00.000000Z\n",
    undefined,
    null,
    1,
  ])("rejects noncanonical or impossible timestamp %j", (value) => {
    expect(parseTestTimestamp(value)).toBeNull();
  });
});

describe("Test projection chronology and exact requests", () => {
  it("accepts all three lifecycles and equal transition instants", () => {
    for (const test of [
      draft,
      { ...draft, lifecycle: "open", openedAt: createdAt },
      { ...draft, lifecycle: "ended", openedAt: createdAt, endedAt: createdAt },
    ])
      expect(parseStaffTest(test)).toEqual(test);
  });
  it.each([
    { lifecycle: "draft", openedAt: createdAt },
    { lifecycle: "draft", endedAt: createdAt },
    { lifecycle: "open" },
    { lifecycle: "open", openedAt: createdAt, endedAt: createdAt },
    { lifecycle: "ended", openedAt: createdAt },
    { lifecycle: "ended", endedAt: createdAt },
    { lifecycle: "closed" },
    { lifecycle: "open", openedAt: "2026-09-08T10:20:30.123455Z" },
    {
      lifecycle: "ended",
      openedAt: "2026-09-08T10:20:30.123458Z",
      endedAt: "2026-09-08T10:20:30.123457Z",
    },
    { lifecycle: "open", openedAt: "2026-09-08T10:20:30.123Z" },
    { openedAt: undefined },
  ])(
    "rejects lifecycle or full-microsecond chronology contradiction %j",
    (fields) => {
      expect(parseStaffTest({ ...draft, ...fields })).toBeNull();
    },
  );
  const cases = [
    { name: "Test", parse: parseStaffTest, value: draft },
    {
      name: "cursor",
      parse: parseTestPageCursor,
      value: { createdAt, testId },
    },
    { name: "list", parse: parseReadSchoolTestsRequest, value: listRequest },
    { name: "detail", parse: parseReadSchoolTestRequest, value: detailRequest },
    {
      name: "create",
      parse: parseCreateSchoolTestRequest,
      value: { schoolId, creationRequestId, title: draft.title },
    },
    {
      name: "revision",
      parse: parseTestRevisionRequest,
      value: revisionRequest,
    },
    {
      name: "title",
      parse: parseUpdateTestTitleRequest,
      value: { ...revisionRequest, title: draft.title },
    },
  ];
  it.each(cases)(
    "requires exact own data fields for $name",
    ({ parse, value }) => {
      expect(parse(value)).toEqual(value);
      expect(parse(Object.assign(Object.create(null), value))).toEqual(value);
      for (const bad of [
        null,
        [],
        { ...value, authorityHandle: "not-a-capability" },
        Object.assign(Object.create({ inherited: true }), value),
        { ...value, [Symbol("extra")]: true },
      ])
        expect(parse(bad)).toBeNull();
      for (const key of Object.keys(value)) {
        const missing: Record<string, unknown> = { ...value };
        delete missing[key];
        expect(parse(missing)).toBeNull();
        const get = vi.fn(() => Reflect.get(value, key));
        const accessor = { ...value };
        Object.defineProperty(accessor, key, { get, enumerable: true });
        expect(parse(accessor)).toBeNull();
        expect(get).not.toHaveBeenCalled();
        expect(
          parse(
            Object.defineProperty({ ...value }, key, { enumerable: false }),
          ),
        ).toBeNull();
      }
      const hostile = new Proxy(value, {
        ownKeys() {
          throw new Error("untrusted trap");
        },
      });
      expect(parse(hostile)).toBeNull();
    },
  );
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
    undefined,
  ])("rejects unsafe revision %j in every revision boundary", (revision) => {
    expect(parseStaffTest({ ...draft, revision })).toBeNull();
    expect(
      parseTestRevisionRequest({
        ...revisionRequest,
        expectedTestRevision: revision,
      }),
    ).toBeNull();
    expect(
      parseUpdateTestTitleRequest({
        ...revisionRequest,
        title: draft.title,
        expectedTestRevision: revision,
      }),
    ).toBeNull();
  });
  it("accepts the safe revision maximum without broadening any other field", () => {
    expect(
      parseStaffTest({ ...draft, revision: Number.MAX_SAFE_INTEGER })?.revision,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      parseTestRevisionRequest({
        ...revisionRequest,
        expectedTestRevision: Number.MAX_SAFE_INTEGER,
      })?.expectedTestRevision,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([
    "20000000-0000-4000-8000-00000000000A",
    "20000000-0000-0000-8000-000000000001",
    "20000000-0000-4000-7000-000000000001",
    "not-a-uuid",
    null,
  ])("rejects noncanonical UUID %j across identity fields", (id) => {
    for (const key of ["id", "schoolId", "createdByProfileId"])
      expect(parseStaffTest({ ...draft, [key]: id })).toBeNull();
    expect(parseTestPageCursor({ createdAt, testId: id })).toBeNull();
    expect(
      parseReadSchoolTestsRequest({ schoolId: id, before: null }),
    ).toBeNull();
    expect(parseReadSchoolTestRequest({ schoolId, testId: id })).toBeNull();
    expect(
      parseCreateSchoolTestRequest({
        schoolId,
        creationRequestId: id,
        title: draft.title,
      }),
    ).toBeNull();
  });
  it("requires a complete canonical cursor and wire title without trimming", () => {
    for (const before of [
      undefined,
      {},
      { createdAt },
      { testId },
      { createdAt: null, testId },
      { createdAt, testId: null },
      { createdAt: createdAt.slice(0, -4) + "Z", testId },
    ])
      expect(parseReadSchoolTestsRequest({ schoolId, before })).toBeNull();
    expect(
      parseReadSchoolTestsRequest({ schoolId, before: { createdAt, testId } }),
    ).toEqual({ schoolId, before: { createdAt, testId } });
    expect(
      parseCreateSchoolTestRequest({
        schoolId,
        creationRequestId,
        title: " Quiz ",
      }),
    ).toBeNull();
    expect(
      parseUpdateTestTitleRequest({ ...revisionRequest, title: " Quiz " }),
    ).toBeNull();
  });
});

describe("request-bound Test readers", () => {
  it("maps the ten-field SQL projection and treats empty list as success only", () => {
    expect(parseReadSchoolTestsRpcResult([], listRequest)).toEqual({
      ok: true,
      page: { items: [], nextCursor: null },
    });
    expect(parseReadSchoolTestsRpcResult([sqlRow()], listRequest)).toEqual({
      ok: true,
      page: { items: [draft], nextCursor: null },
    });
    expect(parseReadSchoolTestRpcResult([sqlRow()], detailRequest)).toEqual({
      ok: true,
      test: draft,
    });
    expect(parseReadSchoolTestRpcResult([], detailRequest)).toBeNull();
  });
  it("preserves microseconds and UUID ties across the fifty-row boundary without gaps", () => {
    const tests = Array.from({ length: 55 }, (_, index): StaffTest => ({
      ...draft,
      id: `20000000-0000-4000-8000-${(100 - index).toString(16).padStart(12, "0")}`,
      createdAt: `2026-09-08T10:20:30.${String(900 - Math.floor(index / 3)).padStart(6, "0")}Z`,
    }));
    const first = parseReadSchoolTestsRpcResult(
      tests.slice(0, 51).map(sqlRow),
      listRequest,
    );
    expect(first?.ok).toBe(true);
    if (!first?.ok) throw new Error("Expected first page");
    expect(first.page.items).toEqual(tests.slice(0, 50));
    expect(first.page.nextCursor).toEqual({
      createdAt: tests[49]?.createdAt,
      testId: tests[49]?.id,
    });
    expect(first.page.nextCursor?.createdAt).toBe(tests[50]?.createdAt);
    expect(first.page.nextCursor?.testId).not.toBe(tests[50]?.id);
    const nextRequest = parseReadSchoolTestsRequest({
      schoolId,
      before: first.page.nextCursor,
    });
    expect(nextRequest).not.toBeNull();
    if (nextRequest === null) throw new Error("Expected exact next request");
    const second = parseReadSchoolTestsRpcResult(
      tests.slice(50).map(sqlRow),
      nextRequest,
    );
    if (!second?.ok) throw new Error("Expected second page");
    expect(second.page.nextCursor).toBeNull();
    expect([...first.page.items, ...second.page.items]).toEqual(tests);
    expect(
      parseReadSchoolTestsRpcResult(
        tests.slice(0, 50).map(sqlRow),
        listRequest,
      ),
    ).toEqual({
      ok: true,
      page: { items: tests.slice(0, 50), nextCursor: null },
    });
    expect(
      parseReadSchoolTestsRpcResult(
        tests.slice(0, 52).map(sqlRow),
        listRequest,
      ),
    ).toBeNull();
    const malformedLookahead = tests.slice(0, 51).map(sqlRow);
    malformedLookahead[50] = { ...sqlRow(), school_id: foreignSchoolId };
    expect(
      parseReadSchoolTestsRpcResult(malformedLookahead, listRequest),
    ).toBeNull();
  });
  it("rejects reversed order, duplicate IDs and tuples outside the request cursor", () => {
    const older = {
      ...draft,
      id: "20000000-0000-4000-8000-000000000002",
      createdAt: "2026-09-08T10:20:30.123455Z",
    };
    expect(
      parseReadSchoolTestsRpcResult([sqlRow(older), sqlRow()], listRequest),
    ).toBeNull();
    expect(
      parseReadSchoolTestsRpcResult(
        [sqlRow(), sqlRow({ ...older, id: testId })],
        listRequest,
      ),
    ).toBeNull();
    expect(
      parseReadSchoolTestsRpcResult([sqlRow(), sqlRow()], listRequest),
    ).toBeNull();
    const largerId = "20000000-0000-4000-8000-000000000003";
    expect(
      parseReadSchoolTestsRpcResult(
        [sqlRow(), sqlRow({ ...draft, id: largerId })],
        listRequest,
      ),
    ).toBeNull();
    const before = { createdAt, testId };
    expect(
      parseReadSchoolTestsRpcResult([sqlRow()], { schoolId, before }),
    ).toBeNull();
    expect(
      parseReadSchoolTestsRpcResult(
        [sqlRow({ ...draft, id: largerId }), sqlRow(older)],
        { schoolId, before },
      ),
    ).toBeNull();
    expect(
      parseReadSchoolTestsRpcResult([sqlRow(older)], { schoolId, before })?.ok,
    ).toBe(true);
    expect(
      parseReadSchoolTestsRpcResult([sqlRow()], {
        schoolId,
        before: { createdAt, testId: largerId },
      })?.ok,
    ).toBe(true);
  });
  it("binds each read to its requested School and target without trusting typed input", () => {
    expect(
      parseReadSchoolTestsRpcResult([sqlRow()], {
        ...listRequest,
        schoolId: foreignSchoolId,
      }),
    ).toBeNull();
    expect(
      parseReadSchoolTestRpcResult([sqlRow()], {
        schoolId: foreignSchoolId,
        testId,
      }),
    ).toBeNull();
    expect(
      parseReadSchoolTestRpcResult([sqlRow()], { schoolId, testId: profileId }),
    ).toBeNull();
    expect(
      parseReadSchoolTestsRpcResult(
        [],
        Object.assign({ ...listRequest }, { role: "owner" }),
      ),
    ).toBeNull();
    expect(
      parseReadSchoolTestRpcResult(
        [sqlRow()],
        Object.assign({ ...detailRequest }, { role: "owner" }),
      ),
    ).toBeNull();
  });
  it.each(accessFailures)(
    "decodes only one all-null read failure: %s",
    (code) => {
      expect(
        parseReadSchoolTestsRpcResult([failureRow(code)], listRequest),
      ).toEqual({ ok: false, code });
      expect(
        parseReadSchoolTestRpcResult([failureRow(code)], detailRequest),
      ).toEqual({ ok: false, code });
      for (const key of Object.keys(failureRow(code)).filter(
        (key) => key !== "code",
      )) {
        const retained = { ...failureRow(code), [key]: "retained-data" };
        expect(
          parseReadSchoolTestsRpcResult([retained], listRequest),
        ).toBeNull();
        expect(
          parseReadSchoolTestRpcResult([retained], detailRequest),
        ).toBeNull();
      }
      expect(
        parseReadSchoolTestsRpcResult(
          [failureRow(code), sqlRow()],
          listRequest,
        ),
      ).toBeNull();
      expect(
        parseReadSchoolTestsRpcResult(
          [sqlRow(), failureRow(code)],
          listRequest,
        ),
      ).toBeNull();
    },
  );
  it("reserves target failure for detail and rejects unrelated or ambiguous rows", () => {
    expect(
      parseReadSchoolTestRpcResult(
        [failureRow("test_unavailable")],
        detailRequest,
      ),
    ).toEqual({ ok: false, code: "test_unavailable" });
    expect(
      parseReadSchoolTestsRpcResult(
        [failureRow("test_unavailable")],
        listRequest,
      ),
    ).toBeNull();
    for (const code of [
      "test_created",
      "test_revision_conflict",
      "test_transition_rejected",
      "school_display_name_updated",
      "membership_inactive_extra",
      "unknown",
    ]) {
      expect(
        parseReadSchoolTestsRpcResult([failureRow(code)], listRequest),
      ).toBeNull();
      expect(
        parseReadSchoolTestRpcResult([failureRow(code)], detailRequest),
      ).toBeNull();
    }
    for (const value of [
      null,
      {},
      [sqlRow(), sqlRow()],
      [{ ...sqlRow(), extra: true }],
      [{ ...sqlRow(), opened_at: undefined }],
    ])
      expect(parseReadSchoolTestRpcResult(value, detailRequest)).toBeNull();
  });
});

describe("closed Test mutation outcomes", () => {
  it.each(["test_created", "test_creation_already_recorded"])(
    "acknowledges create identity for %s only",
    (code) => {
      expect(
        parseCreateSchoolTestRpcResult([{ code, test_id: testId }]),
      ).toEqual({ ok: true, code, testId });
      expect(
        parseCreateSchoolTestRpcResult([{ code, test_id: null }]),
      ).toBeNull();
      expect(
        parseCreateSchoolTestRpcResult([
          { code, test_id: testId, title: draft.title },
        ]),
      ).toBeNull();
    },
  );
  it.each(accessFailures)(
    "requires a null Test identity on create failure %s",
    (code) => {
      expect(parseCreateSchoolTestRpcResult([{ code, test_id: null }])).toEqual(
        { ok: false, code },
      );
      expect(
        parseCreateSchoolTestRpcResult([{ code, test_id: testId }]),
      ).toBeNull();
    },
  );
  const revisionDecoders = [
    {
      name: "title",
      parse: parseUpdateTestTitleRpcResult,
      successes: ["test_title_updated", "test_title_unchanged"],
    },
    {
      name: "open",
      parse: parseOpenTestRpcResult,
      successes: ["test_opened", "test_already_open"],
    },
    {
      name: "end",
      parse: parseEndTestRpcResult,
      successes: ["test_ended", "test_already_ended"],
    },
  ];
  it.each(revisionDecoders)(
    "accepts only its own code-only successes and closed failures: $name",
    ({ parse, successes }) => {
      for (const code of successes)
        expect(parse([{ code }])).toEqual({ ok: true, code });
      for (const code of [
        ...accessFailures,
        "test_unavailable",
        "test_revision_conflict",
        "test_transition_rejected",
      ])
        expect(parse([{ code }])).toEqual({ ok: false, code });
      for (const code of [
        ...revisionDecoders.flatMap((entry) => entry.successes),
        "test_created",
        "test_creation_already_recorded",
        "ok",
        "conflict",
        "rate_limited",
        "unknown",
        "membership_revoked",
        "school_settings_revision_conflict",
      ])
        if (!successes.includes(code)) expect(parse([{ code }])).toBeNull();
      for (const value of [
        null,
        [],
        { code: successes[0] },
        [{ code: successes[0] }, { code: successes[0] }],
        [{ code: successes[0], test_id: testId }],
      ])
        expect(parse(value)).toBeNull();
    },
  );
  it("does not widen create's failure or success vocabulary", () => {
    for (const code of [
      "test_unavailable",
      "test_revision_conflict",
      "test_transition_rejected",
      "test_opened",
      "conflict",
      "rate_limited",
      "unknown",
    ])
      expect(
        parseCreateSchoolTestRpcResult([{ code, test_id: null }]),
      ).toBeNull();
    for (const value of [
      [],
      [
        { code: "test_created", test_id: testId },
        { code: "test_created", test_id: testId },
      ],
      [{ code: "test_created" }],
    ])
      expect(parseCreateSchoolTestRpcResult(value)).toBeNull();
  });
  it("rejects decorated, sparse, accessor and hostile result arrays without executing getters", () => {
    const decoders = [
      (value: unknown) => parseReadSchoolTestsRpcResult(value, listRequest),
      (value: unknown) => parseReadSchoolTestRpcResult(value, detailRequest),
      parseCreateSchoolTestRpcResult,
      ...revisionDecoders.map(({ parse }) => parse),
    ];
    const rows = [
      sqlRow(),
      sqlRow(),
      { code: "test_created", test_id: testId },
      { code: "test_title_updated" },
      { code: "test_opened" },
      { code: "test_ended" },
    ];
    decoders.forEach((parse, index) => {
      const row = rows[index];
      const get = vi.fn(() => row);
      const accessor = Object.defineProperty([row], "0", {
        get,
        enumerable: true,
      });
      const sparse = new Array(1);
      const decorated = Object.assign([row], { extra: true });
      const hostile = new Proxy([row], {
        ownKeys() {
          throw new Error("untrusted trap");
        },
      });
      const rowAccessor = Object.defineProperty({ ...row }, "code", {
        get,
        enumerable: true,
      });
      for (const value of [accessor, sparse, decorated, hostile, [rowAccessor]])
        expect(parse(value)).toBeNull();
      expect(get).not.toHaveBeenCalled();
    });
  });
});
