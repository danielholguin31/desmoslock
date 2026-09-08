import {
  parseStudentSessionViewState,
  type StudentSessionViewState,
} from "@desmoslock/contracts";

import {
  parseLocalEndCause,
  parseProtectionCategories,
  type CleanupState,
  type LocalEndCause,
  type ProtectionCategories,
  type ProtectionPhase,
} from "./main/assessment-protection-types.js";

export const assessmentToolbarHeight = 96;

export interface DesktopStudentView {
  readonly revision: number;
  readonly admission: Omit<
    StudentSessionViewState,
    "revision" | "protection" | "calculatorEligible"
  >;
  readonly protection: {
    readonly phase: ProtectionPhase;
    readonly categories: ProtectionCategories;
    readonly calculatorVisible: boolean;
    readonly failure: LocalEndCause | null;
    readonly nativeEndObserved: boolean;
    readonly cleanup: CleanupState;
    readonly evidence: "none" | "queued" | "full" | "unconfirmed";
    readonly emergencyReview: boolean;
  };
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return null;
  const row: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return null;
    row[key] = descriptor.value;
  }
  return row;
}

function parsePhase(value: unknown): ProtectionPhase | null {
  switch (value) {
    case "idle":
    case "preflight":
    case "engaging":
    case "locked":
    case "ending":
    case "ended":
    case "failed":
    case "recovery_required":
      return value;
    default:
      return null;
  }
}

export function parseDesktopStudentView(
  value: unknown,
): DesktopStudentView | null {
  try {
    const row = exact(value, ["revision", "admission", "protection"]);
    if (
      row === null ||
      typeof row.revision !== "number" ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1
    )
      return null;
    const ownAdmission = exact(row.admission, [
      "phase",
      "session",
      "pendingOperation",
    ]);
    const protection = exact(row.protection, [
      "phase",
      "categories",
      "calculatorVisible",
      "failure",
      "nativeEndObserved",
      "cleanup",
      "evidence",
      "emergencyReview",
    ]);
    if (ownAdmission === null || protection === null) return null;
    const admission = parseStudentSessionViewState({
      revision: row.revision,
      phase: ownAdmission.phase,
      session: ownAdmission.session,
      protection: "unavailable",
      calculatorEligible: false,
      pendingOperation: ownAdmission.pendingOperation,
    });
    const phase = parsePhase(protection.phase);
    const categories = parseProtectionCategories(protection.categories);
    const failure = parseLocalEndCause(protection.failure);
    const cleanup = protection.cleanup;
    const evidence = protection.evidence;
    if (
      admission === null ||
      phase === null ||
      categories === null ||
      (protection.failure !== null && failure === null) ||
      typeof protection.calculatorVisible !== "boolean" ||
      typeof protection.nativeEndObserved !== "boolean" ||
      typeof protection.emergencyReview !== "boolean" ||
      (cleanup !== "not_requested" &&
        cleanup !== "pending" &&
        cleanup !== "complete" &&
        cleanup !== "unconfirmed") ||
      (evidence !== "none" &&
        evidence !== "queued" &&
        evidence !== "full" &&
        evidence !== "unconfirmed")
    )
      return null;
    if ((phase === "locked") !== protection.calculatorVisible) return null;
    if (
      phase === "locked" &&
      (admission.phase !== "active" ||
        (admission.pendingOperation !== null &&
          admission.pendingOperation !== "reconnect") ||
        failure !== null ||
        cleanup !== "not_requested" ||
        protection.nativeEndObserved ||
        Object.values(categories).some(
          (category) => category.status !== "confirmed",
        ))
    )
      return null;
    if (
      phase === "ended" &&
      (!protection.nativeEndObserved || cleanup !== "complete")
    )
      return null;
    if (
      protection.nativeEndObserved &&
      phase !== "ended" &&
      phase !== "ending" &&
      phase !== "recovery_required"
    )
      return null;
    return Object.freeze({
      revision: row.revision,
      admission: Object.freeze({
        phase: admission.phase,
        session:
          admission.session === null ? null : Object.freeze(admission.session),
        pendingOperation: admission.pendingOperation,
      }),
      protection: Object.freeze({
        phase,
        categories,
        calculatorVisible: protection.calculatorVisible,
        failure,
        nativeEndObserved: protection.nativeEndObserved,
        cleanup,
        evidence,
        emergencyReview: protection.emergencyReview,
      }),
    });
  } catch {
    return null;
  }
}
