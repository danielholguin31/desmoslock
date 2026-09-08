import { describe, expect, it, vi } from "vitest";

import { parseDesktopStudentView } from "../src/assessment-protection-view-state.js";
import { parseProtectionCategories } from "../src/main/assessment-protection-types.js";

function locked() {
  return {
    revision: 3,
    admission: {
      phase: "active",
      session: {
        syntheticDisplayName: "Student CEDAR",
        sessionRevision: 1,
        capabilityExpiresAtMs: 2_000_000_000_000,
      },
      pendingOperation: null,
    },
    protection: {
      phase: "locked",
      categories: {
        aac: { status: "confirmed", code: "none" },
        shortcuts: { status: "confirmed", code: "none" },
        applications: { status: "confirmed", code: "none" },
        persistence: { status: "confirmed", code: "none" },
        windowNetwork: { status: "confirmed", code: "none" },
      },
      calculatorVisible: true,
      failure: null,
      nativeEndObserved: false,
      cleanup: "not_requested",
      evidence: "queued",
      emergencyReview: false,
    },
  };
}

describe("closed desktop protection projection", () => {
  it("copies and freezes an exact active five-category projection", () => {
    const input = locked();
    const result = parseDesktopStudentView(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.admission.session)).toBe(true);
    expect(Object.isFrozen(result?.protection.categories.aac)).toBe(true);
    input.protection.categories.aac.status = "failed";
    expect(result?.protection.categories.aac.status).toBe("confirmed");
  });

  it.each([
    "aac",
    "shortcuts",
    "applications",
    "persistence",
    "windowNetwork",
  ] as const)(
    "does not claim a visible calculator without confirmed %s",
    (category) => {
      const input = locked();
      input.protection.categories[category] = {
        status: "pending",
        code: "none",
      };
      expect(parseDesktopStudentView(input)).toBeNull();
    },
  );

  it.each(["admission", "cleanup", "visibility", "end", "pending", "revision"])(
    "rejects a contradictory locked %s",
    (variant) => {
      const input = locked();
      if (variant === "admission") input.admission.phase = "unavailable";
      if (variant === "cleanup") input.protection.cleanup = "complete";
      if (variant === "visibility") input.protection.calculatorVisible = false;
      if (variant === "end") input.protection.nativeEndObserved = true;
      if (variant === "pending")
        Object.assign(input.admission, { pendingOperation: "forfeit" });
      if (variant === "revision") input.revision = Number.MAX_SAFE_INTEGER + 1;
      expect(parseDesktopStudentView(input)).toBeNull();
    },
  );

  it("accepts ended native ownership with unconfirmed durable cleanup honestly", () => {
    const input = locked();
    Object.assign(input.protection, {
      phase: "recovery_required",
      calculatorVisible: false,
      nativeEndObserved: true,
      cleanup: "unconfirmed",
      failure: "persistence_unavailable",
      evidence: "unconfirmed",
      emergencyReview: true,
    });
    expect(parseDesktopStudentView(input)).toEqual(input);
  });

  it("rejects extra private fields at every nested boundary", () => {
    for (const target of [
      "root",
      "admission",
      "session",
      "protection",
      "categories",
      "aac",
    ]) {
      const input = locked();
      const object =
        target === "root"
          ? input
          : target === "admission"
            ? input.admission
            : target === "session"
              ? input.admission.session
              : target === "protection"
                ? input.protection
                : target === "categories"
                  ? input.protection.categories
                  : input.protection.categories.aac;
      Object.assign(object, { capabilityToken: "synthetic-private" });
      expect(parseDesktopStudentView(input)).toBeNull();
    }
  });

  it("does not invoke getters or accept malformed category codes", () => {
    const input = locked();
    const getter = vi.fn(() => input.protection);
    Object.defineProperty(input, "protection", {
      get: getter,
      enumerable: true,
    });
    expect(parseDesktopStudentView(input)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    const wrong = locked();
    wrong.protection.categories.aac = {
      status: "unavailable",
      code: "backend_unavailable",
    };
    expect(parseProtectionCategories(wrong.protection.categories)).toBeNull();
    expect(parseDesktopStudentView(wrong)).toBeNull();
  });
});
