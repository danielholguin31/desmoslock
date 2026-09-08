export type ProtectionPhase =
  | "idle"
  | "preflight"
  | "engaging"
  | "locked"
  | "ending"
  | "ended"
  | "failed"
  | "recovery_required";

export type NativeDisposition =
  | "not_started"
  | "pending"
  | "active"
  | "failed_to_begin"
  | "ended"
  | "disposed_without_terminal_observation"
  | "unknown";

export type CleanupState =
  "not_requested" | "pending" | "complete" | "unconfirmed";

export type LocalEndCause =
  | "backend_unavailable"
  | "admission_changed"
  | "capability_expired"
  | "native_interrupted"
  | "native_failure"
  | "observation_timeout"
  | "application_policy"
  | "shortcut_unavailable"
  | "persistence_unavailable"
  | "window_lost"
  | "renderer_lost"
  | "suspend"
  | "display_changed"
  | "emergency_abandonment"
  | "application_quit";

export function parseLocalEndCause(value: unknown): LocalEndCause | null {
  switch (value) {
    case "backend_unavailable":
    case "admission_changed":
    case "capability_expired":
    case "native_interrupted":
    case "native_failure":
    case "observation_timeout":
    case "application_policy":
    case "shortcut_unavailable":
    case "persistence_unavailable":
    case "window_lost":
    case "renderer_lost":
    case "suspend":
    case "display_changed":
    case "emergency_abandonment":
    case "application_quit":
      return value;
    default:
      return null;
  }
}

export type ProtectionCategoryStatus =
  "pending" | "confirmed" | "failed" | "unavailable";

export type ProtectionCategoryCode =
  | "none"
  | "awaiting_native_begin"
  | "native_unavailable"
  | "native_inactive"
  | "emergency_shortcut_unavailable"
  | "prohibited_application"
  | "application_observation_unavailable"
  | "durability_unavailable"
  | "evidence_capacity"
  | "window_unavailable"
  | "network_policy_unavailable"
  | "backend_unavailable";

export interface ProtectionCategoryObservation {
  readonly status: ProtectionCategoryStatus;
  readonly code: ProtectionCategoryCode;
}

export interface ProtectionCategories {
  readonly aac: ProtectionCategoryObservation;
  readonly shortcuts: ProtectionCategoryObservation;
  readonly applications: ProtectionCategoryObservation;
  readonly persistence: ProtectionCategoryObservation;
  readonly windowNetwork: ProtectionCategoryObservation;
}

const categoryFailures = {
  aac: ["native_unavailable", "native_inactive"],
  shortcuts: ["emergency_shortcut_unavailable"],
  applications: [
    "prohibited_application",
    "application_observation_unavailable",
  ],
  persistence: ["durability_unavailable", "evidence_capacity"],
  windowNetwork: [
    "window_unavailable",
    "network_policy_unavailable",
    "backend_unavailable",
  ],
} as const satisfies Record<
  keyof ProtectionCategories,
  readonly ProtectionCategoryCode[]
>;

function exactData(
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
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return null;
    result[key] = descriptor.value;
  }
  return result;
}

export function parseProtectionCategories(
  value: unknown,
): ProtectionCategories | null {
  try {
    const keys = [
      "aac",
      "shortcuts",
      "applications",
      "persistence",
      "windowNetwork",
    ] as const;
    const row = exactData(value, keys);
    if (row === null) return null;
    const parsed = {} as Record<
      keyof ProtectionCategories,
      ProtectionCategoryObservation
    >;
    for (const key of keys) {
      const entry = exactData(row[key], ["status", "code"]);
      if (entry === null || typeof entry.code !== "string") return null;
      if (entry.status === "confirmed") {
        if (entry.code !== "none") return null;
      } else if (entry.status === "pending") {
        if (
          entry.code !== "none" &&
          !(key === "aac" && entry.code === "awaiting_native_begin")
        )
          return null;
      } else if (entry.status === "failed" || entry.status === "unavailable") {
        const allowed: readonly string[] = categoryFailures[key];
        if (!allowed.includes(entry.code)) return null;
      } else return null;
      parsed[key] = Object.freeze({
        status: entry.status,
        code: entry.code as ProtectionCategoryCode,
      });
    }
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}
