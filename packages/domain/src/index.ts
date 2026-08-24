export type WorkspaceKind = "personal" | "school";

export type MembershipRole = "owner" | "administrator" | "teacher";

export type MembershipStatus = "active" | "suspended" | "removed";

export type TestLifecycle = "draft" | "open" | "ended";

export type LockState = "unlocked" | "locked";

export type StudentSessionState =
  "active" | "left" | "released" | "removed" | "forfeited" | "ended";

export type EntitlementState =
  | "trialing"
  | "active"
  | "past_due"
  | "restricted"
  | "canceling"
  | "expired"
  | "suspended";

export const retentionMaximumDays = {
  diagnosticExport: 14,
  invitation: 90,
  studentRecord: 30,
  testMetadata: 365,
  workspaceAudit: 365,
} as const;

export const backupDeletionMaximumAdditionalDays = 35;
export const calculatorStateMaximumHoursAfterTestEnd = 24;

export {
  clearStaleLockedState,
  engagePersistedLock,
  releaseRecoveryLock,
  restoreStudentSession,
} from "./student-session.js";
export type {
  RestoredStudentSession,
  StudentSessionLookup,
} from "./student-session.js";
