import { describe, expect, it, vi } from "vitest";
import {
  createNativeProtectionAdapter,
  NativeProtectionUnavailableError,
  type NativeAssessmentEvent,
  type NativeEventType,
} from "../src/main/native-protection-adapter.js";

const id = "12345678-1234-4abc-8abc-123456789abc";
const other = "22345678-1234-4abc-8abc-123456789abc";
const support = {
  available: true,
  reason: "api_available_authorization_unverified",
};
const clear = { status: "clear", reason: "policy_clear" };
function event(type: NativeEventType, sequence: number, attemptId = id) {
  return {
    type,
    sequence,
    attemptId,
    code:
      type === "failed_to_begin"
        ? "native_failed_to_begin"
        : type === "interrupted"
          ? "native_interrupted"
          : "none",
  };
}
function fixture() {
  let lifecycle: (value: unknown) => void = () => {
    throw new Error("No synthetic lifecycle subscription");
  };
  let applications: (value: unknown) => void = () => {
    throw new Error("No synthetic application subscription");
  };
  const releaseLifecycle = vi.fn<() => unknown>(() => true);
  const releaseApplications = vi.fn<() => unknown>(() => true);
  const native = {
    inspectSupport: vi.fn<() => unknown>(() => support),
    subscribe: vi.fn<(listener: unknown) => unknown>((listener) => {
      if (typeof listener !== "function")
        throw new Error("Synthetic callback missing");
      lifecycle = listener as (value: unknown) => void;
      return releaseLifecycle;
    }),
    observeApplicationStatus: vi.fn<(listener: unknown) => unknown>(
      (listener) => {
        if (typeof listener !== "function")
          throw new Error("Synthetic callback missing");
        applications = listener as (value: unknown) => void;
        return releaseApplications;
      },
    ),
    readApplicationStatus: vi.fn<() => unknown>(() => clear),
    begin: vi.fn<(attemptId: string) => unknown>(() => true),
    requestEnd: vi.fn<(attemptId: string) => unknown>(() => true),
    isAttemptActive: vi.fn<(attemptId: string, sequence: number) => unknown>(
      () => true,
    ),
    disposeAfterEnd: vi.fn<() => unknown>(() => true),
  };
  const load = vi.fn(() => native);
  const adapter = createNativeProtectionAdapter(load);
  const received: NativeAssessmentEvent[] = [];
  return {
    native,
    load,
    adapter,
    received,
    releaseLifecycle,
    releaseApplications,
    emit: (value: unknown) => lifecycle(value),
    observe: (value: unknown) => applications(value),
    prepare() {
      const unsubscribe = adapter.subscribe((value) => received.push(value));
      const unobserve = adapter.observeApplicationStatus(() => {});
      expect(adapter.readApplicationStatus()).toEqual(clear);
      adapter.begin(id);
      return { unsubscribe, unobserve };
    },
  };
}
function expectFinite(body: () => unknown) {
  try {
    body();
  } catch (error) {
    expect(error).toBeInstanceOf(NativeProtectionUnavailableError);
    expect(error).toMatchObject({
      name: "NativeProtectionUnavailableError",
      code: "NATIVE_PROTECTION_UNAVAILABLE",
      message: "Native protection is unavailable",
    });
    expect(String(error)).not.toContain("sensitive native details");
    return;
  }
  throw new Error("Expected a finite adapter failure");
}

describe("main-private native protection adapter with a synthetic module only", () => {
  it("loads lazily once, snapshots methods and never equates availability with engagement", () => {
    const f = fixture();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.adapter.readApplicationStatus()).toEqual({
      status: "unavailable",
      reason: "observation_not_started",
    });
    expect(f.adapter.inspectSupport()).toEqual(support);
    expect(f.adapter.isAttemptActive(id, 2)).toBe(false);
    f.native.inspectSupport = vi.fn(() => {
      throw new Error("replaced");
    });
    expect(f.adapter.inspectSupport()).toEqual(support);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.native.begin).not.toHaveBeenCalled();
  });

  it("requires exactly eight own data methods without evaluating accessor contents", () => {
    let getters = 0;
    const accessor = { ...fixture().native };
    Object.defineProperty(accessor, "begin", {
      get() {
        getters += 1;
        return () => true;
      },
    });
    const missing = { ...fixture().native } as Record<string, unknown>;
    delete missing.begin;
    for (const invalid of [
      null,
      [],
      {},
      missing,
      { ...fixture().native, extra: true },
      { ...fixture().native, [Symbol("extra")]: true },
      Object.create(fixture().native),
      accessor,
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("sensitive native details");
          },
        },
      ),
    ]) {
      const load = vi.fn(() => invalid);
      const adapter = createNativeProtectionAdapter(load);
      expect(adapter.inspectSupport()).toEqual({
        available: false,
        reason: "api_unavailable",
      });
      expectFinite(() => adapter.subscribe(() => {}));
      expectFinite(() => adapter.disposeAfterEnd());
      expect(load).toHaveBeenCalledTimes(1);
    }
    expect(getters).toBe(0);
  });

  it("retains a failed or reentrant loader rather than retrying over it", () => {
    const load = vi.fn(() => {
      throw new Error("sensitive native details");
    });
    const failed = createNativeProtectionAdapter(load);
    expect(failed.inspectSupport().available).toBe(false);
    expectFinite(() => failed.disposeAfterEnd());
    expect(load).toHaveBeenCalledTimes(1);
    const native = fixture().native;
    const reentrant = vi.fn(() => {
      expectFinite(() => adapter.disposeAfterEnd());
      return native;
    });
    const adapter = createNativeProtectionAdapter(reentrant);
    expect(adapter.inspectSupport().available).toBe(false);
    expect(native.inspectSupport).not.toHaveBeenCalled();
    expect(() => adapter.disposeAfterEnd()).not.toThrow();
    expect(adapter.inspectSupport().available).toBe(false);
    expect(reentrant).toHaveBeenCalledTimes(1);
  });

  it("captures native methods without inherited setters or substitute getters", () => {
    const f = fixture();
    let accesses = 0;
    const before = Object.getOwnPropertyDescriptor(Object.prototype, "begin");
    Object.defineProperty(Object.prototype, "begin", {
      configurable: true,
      get() {
        accesses += 1;
        return () => true;
      },
      set() {
        accesses += 1;
      },
    });
    try {
      f.prepare();
      expect(f.native.begin).toHaveBeenCalledWith(id);
      expect(accesses).toBe(0);
    } finally {
      if (before === undefined)
        Reflect.deleteProperty(Object.prototype, "begin");
      else Object.defineProperty(Object.prototype, "begin", before);
    }
  });

  it("rejects and consumes async or thenable listeners without leaving native eligibility", async () => {
    const f = fixture();
    f.adapter.subscribe(async () => {
      throw new Error("sensitive native details");
    });
    f.adapter.observeApplicationStatus(() => {});
    f.adapter.begin(id);
    expectFinite(() => f.emit(event("did_begin", 2)));
    expect(f.native.requestEnd).toHaveBeenCalledWith(id);
    expect(f.adapter.isAttemptActive(id, 2)).toBe(false);
    const g = fixture();
    g.adapter.observeApplicationStatus(() => ({
      then(_resolve: unknown, reject: (reason: unknown) => void) {
        reject(new Error("sensitive native details"));
      },
    }));
    expectFinite(() => g.observe(clear));
    await Promise.resolve();
    await Promise.resolve();
    expect(g.adapter.inspectSupport().available).toBe(false);
  });

  it("decodes exact support pairs and rejects accessors, symbols and reflection reentrancy", () => {
    let getters = 0;
    const accessor = {
      available: true,
      get reason() {
        getters += 1;
        return support.reason;
      },
    };
    for (const invalid of [
      true,
      { available: 1, reason: support.reason },
      { ...support, reason: "api_unavailable" },
      { available: false, reason: support.reason },
      { ...support, extra: true },
      { ...support, [Symbol()]: true },
      accessor,
    ]) {
      const f = fixture();
      f.native.inspectSupport.mockReturnValue(invalid);
      expect(f.adapter.inspectSupport().available).toBe(false);
      f.native.inspectSupport.mockReturnValue(support);
      expect(f.adapter.inspectSupport().available).toBe(false);
    }
    expect(getters).toBe(0);
    const f = fixture();
    f.native.inspectSupport.mockReturnValue(
      new Proxy(support, {
        ownKeys(target) {
          expectFinite(() => f.adapter.disposeAfterEnd());
          return Reflect.ownKeys(target);
        },
      }),
    );
    expect(f.adapter.inspectSupport().available).toBe(false);
  });

  it("takes immutable finite app observations and rejects mismatched or unknown shapes", () => {
    for (const observation of [
      clear,
      { status: "blocked", reason: "prohibited_application" },
      ...[
        "observation_not_started",
        "observation_failed",
        "application_identity_unavailable",
      ].map((reason) => ({ status: "unavailable", reason })),
    ]) {
      const f = fixture();
      f.adapter.observeApplicationStatus(() => {});
      f.native.readApplicationStatus.mockReturnValue(observation);
      expect(f.adapter.readApplicationStatus()).toEqual(observation);
      expect(Object.isFrozen(f.adapter.readApplicationStatus())).toBe(true);
    }
    for (const invalid of [
      { ...clear, reason: "observation_failed" },
      { ...clear, status: "unknown" },
      { ...clear, extra: true },
      { status: "unavailable", reason: "private inventory" },
    ]) {
      const f = fixture();
      f.prepare();
      f.native.readApplicationStatus.mockReturnValue(invalid);
      expect(f.adapter.readApplicationStatus()).toEqual({
        status: "unavailable",
        reason: "observation_failed",
      });
      expect(f.native.requestEnd).toHaveBeenCalledWith(id);
    }
  });

  it("requires true acknowledgments and preserves the begun attempt after failure", () => {
    for (const result of [false, undefined, 1, {}, Promise.resolve(true)]) {
      const f = fixture();
      f.native.begin.mockReturnValue(result);
      expectFinite(() => f.prepare());
      expect(f.native.requestEnd).toHaveBeenCalledWith(id);
      expectFinite(() => f.adapter.begin(other));
      expect(f.native.begin).toHaveBeenCalledTimes(1);
      expect(f.adapter.isAttemptActive(id, 2)).toBe(false);
    }
  });

  it("rejects invalid caller input without disturbing a retained attempt", () => {
    const f = fixture();
    f.prepare();
    f.emit(event("did_begin", 2));
    for (const invalid of [
      "",
      id.toUpperCase(),
      id.replace("4abc", "1abc"),
      `${id}x`,
      other,
    ]) {
      expectFinite(() => f.adapter.begin(invalid));
      expectFinite(() => f.adapter.requestEnd(invalid));
    }
    for (const invalid of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(f.adapter.isAttemptActive(id, invalid)).toBe(false);
    expect(f.adapter.isAttemptActive(other, 2)).toBe(false);
    expect(f.native.begin).toHaveBeenCalledTimes(1);
    expect(f.native.requestEnd).not.toHaveBeenCalled();
    expect(f.adapter.isAttemptActive(id, 2)).toBe(true);
  });

  it("coalesces an identical event and accepts sparse sequence advances", () => {
    const f = fixture();
    f.prepare();
    const begin = event("did_begin", 2);
    f.emit(begin);
    begin.sequence = 7;
    f.emit(event("did_begin", 2));
    expect(f.received).toEqual([event("did_begin", 2)]);
    expect(Object.isFrozen(f.received[0])).toBe(true);
    expect(f.adapter.isAttemptActive(id, 2)).toBe(true);
    f.adapter.begin(id);
    expect(f.native.begin).toHaveBeenCalledTimes(1);
    f.emit(event("interrupted", 8));
    f.emit(event("did_end", 14));
    expect(f.received.map((value) => value.sequence)).toEqual([2, 8, 14]);
    expect(f.adapter.isAttemptActive(id, 2)).toBe(false);
    expect(() => f.adapter.disposeAfterEnd()).not.toThrow();
  });

  it("rejects stale, contradictory, unsafe and wrong-attempt events without positive revival", () => {
    for (const invalid of [
      event("interrupted", 1),
      event("interrupted", 2),
      event("did_begin", 3),
      event("failed_to_begin", 3),
      event("did_end", 3, other),
      event("did_end", Number.MAX_SAFE_INTEGER + 1),
      { ...event("did_end", 3), code: "native_interrupted" },
      { ...event("did_end", 3), extra: true },
    ]) {
      const f = fixture();
      f.prepare();
      f.emit(event("did_begin", 2));
      expectFinite(() => f.emit(invalid));
      expect(f.received).toHaveLength(1);
      expect(f.adapter.isAttemptActive(id, 2)).toBe(false);
      expect(f.native.requestEnd).toHaveBeenCalledWith(id);
      f.emit(event("did_end", 9));
      expect(f.received.at(-1)?.type).toBe("did_end");
      expect(() => f.adapter.disposeAfterEnd()).not.toThrow();
      expect(f.adapter.inspectSupport().available).toBe(false);
    }
  });

  it("sanitizes event accessors and thrown consumers while retaining terminal callbacks", () => {
    const f = fixture();
    let getters = 0;
    f.adapter.subscribe(() => {
      throw new Error("sensitive native details");
    });
    f.adapter.observeApplicationStatus(() => {});
    f.adapter.begin(id);
    expectFinite(() => f.emit(event("did_begin", 2)));
    expect(f.native.requestEnd).toHaveBeenCalledWith(id);
    expectFinite(() => f.emit(event("did_end", 8)));
    expect(() => f.adapter.disposeAfterEnd()).not.toThrow();
    const g = fixture();
    g.prepare();
    const accessor = {
      ...event("did_begin", 2),
      get code() {
        getters += 1;
        return "none";
      },
    };
    expectFinite(() => g.emit(accessor));
    expect(getters).toBe(0);
    expect(g.adapter.isAttemptActive(id, 2)).toBe(false);
  });

  it("latches preflight callback failure even when there is no attempt to end", () => {
    const f = fixture();
    f.adapter.subscribe(() => {});
    f.adapter.observeApplicationStatus(() => {
      throw new Error("sensitive native details");
    });
    expectFinite(() => f.observe(clear));
    expect(f.adapter.readApplicationStatus().status).toBe("unavailable");
    expectFinite(() => f.adapter.begin(id));
    expect(f.native.begin).not.toHaveBeenCalled();
    expect(() => f.adapter.disposeAfterEnd()).not.toThrow();
    expect(f.adapter.inspectSupport().available).toBe(false);
  });

  it("does not hide a synchronous subscription callback failure behind a returned disposer", () => {
    const f = fixture();
    f.native.subscribe.mockImplementation((listener) => {
      if (typeof listener !== "function") throw new Error("not a callback");
      expectFinite(() => listener(event("did_begin", 2)));
      return f.releaseLifecycle;
    });
    expectFinite(() => f.adapter.subscribe(() => {}));
    expectFinite(() => f.adapter.subscribe(() => {}));
    expect(f.native.subscribe).toHaveBeenCalledTimes(1);
    expect(() => f.adapter.disposeAfterEnd()).not.toThrow();
    expect(f.native.disposeAfterEnd).toHaveBeenCalledTimes(1);
  });

  it("defers cleanup until a reentrant native begin invocation returns", () => {
    const f = fixture();
    const order: string[] = [];
    f.native.begin.mockImplementation(() => {
      order.push("begin-enter");
      expectFinite(() => f.emit(event("did_begin", 2)));
      expect(f.native.requestEnd).not.toHaveBeenCalled();
      order.push("begin-return");
      return true;
    });
    f.native.requestEnd.mockImplementation(() => {
      order.push("end");
      return true;
    });
    expectFinite(() => f.prepare());
    expect(order).toEqual(["begin-enter", "begin-return", "end"]);
    expect(f.received).toEqual([]);
  });

  it("retains a failed disposer for retry and does not let an old disposer close its successor", () => {
    const f = fixture();
    const unsubscribe = f.adapter.subscribe(() => {});
    f.releaseLifecycle.mockImplementationOnce(() => {
      throw new Error("sensitive native details");
    });
    expectFinite(unsubscribe);
    expectFinite(() => f.adapter.subscribe(() => {}));
    expect(() => unsubscribe()).not.toThrow();
    expect(f.releaseLifecycle).toHaveBeenCalledTimes(2);
    expect(f.adapter.inspectSupport().available).toBe(false);
    const g = fixture();
    const old = g.adapter.subscribe(() => {});
    old();
    const current = g.adapter.subscribe(() => {});
    old();
    expect(g.releaseLifecycle).toHaveBeenCalledTimes(1);
    current();
    expect(g.releaseLifecycle).toHaveBeenCalledTimes(2);
  });

  it("retains native ownership on failed disposal and suppresses old callbacks only after success", () => {
    const f = fixture();
    f.prepare();
    f.emit(event("did_begin", 2));
    f.native.disposeAfterEnd.mockImplementationOnce(() => {
      throw new Error("sensitive native details");
    });
    expectFinite(() => f.adapter.disposeAfterEnd());
    expect(f.native.requestEnd).toHaveBeenCalledWith(id);
    f.emit(event("did_end", 8));
    expect(f.received.at(-1)?.type).toBe("did_end");
    expect(() => f.adapter.disposeAfterEnd()).not.toThrow();
    expect(() => f.emit({ sensitive: "old callback" })).not.toThrow();
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.adapter.inspectSupport().available).toBe(false);
  });

  it("does not hide a new callback fault during already-poisoned cleanup", () => {
    const f = fixture();
    f.prepare();
    expectFinite(() => f.emit({ invalid: true }));
    f.native.disposeAfterEnd.mockImplementationOnce(() => {
      expectFinite(() => f.emit({ invalid: true }));
      return true;
    });
    expectFinite(() => f.adapter.disposeAfterEnd());
    f.emit(event("did_end", 8));
    expect(f.received.at(-1)?.type).toBe("did_end");
    expect(() => f.adapter.disposeAfterEnd()).not.toThrow();
  });

  it("prevents late begin after cancellation and checks the native predicate after an await", async () => {
    const f = fixture();
    f.prepare();
    f.adapter.requestEnd(id);
    expectFinite(() => f.emit(event("did_begin", 2)));
    expect(f.received).toHaveLength(0);
    const g = fixture();
    g.prepare();
    g.emit(event("did_begin", 2));
    expect(g.adapter.isAttemptActive(id, 2)).toBe(true);
    await Promise.resolve();
    g.native.isAttemptActive.mockReturnValue(false);
    expect(g.adapter.isAttemptActive(id, 2)).toBe(false);
    g.native.isAttemptActive.mockReturnValue(true);
    expect(g.adapter.isAttemptActive(id, 2)).toBe(false);
    expect(g.native.requestEnd).toHaveBeenCalledWith(id);
    expect(g.adapter.inspectSupport()).toEqual(support);
  });

  it("rejects nonboolean activity without forwarding native content", () => {
    const f = fixture();
    f.prepare();
    f.emit(event("did_begin", 2));
    f.native.isAttemptActive.mockReturnValue({
      active: true,
      secret: "sensitive native details",
    });
    expect(f.adapter.isAttemptActive(id, 2)).toBe(false);
    expect(f.adapter.inspectSupport().available).toBe(false);
  });

  it("allows a clean failed-start disposal and new same-wrapper cycle", () => {
    const f = fixture();
    f.prepare();
    f.emit(event("failed_to_begin", 4));
    f.adapter.disposeAfterEnd();
    f.adapter.subscribe(() => {});
    f.adapter.observeApplicationStatus(() => {});
    f.adapter.begin(other);
    expect(f.native.begin.mock.calls).toEqual([[id], [other]]);
    expect(f.load).toHaveBeenCalledTimes(1);
  });
});
