import type {
  EntitlementState,
  LockState,
  TestLifecycle,
  WorkspaceKind,
} from "@desmoslock/domain";

export type ApiEnvironment = "development" | "staging" | "production";

export interface RepositoryBuildIdentity {
  readonly sourceCommit: string;
  readonly sourceRepository: string;
  readonly version: string;
}

export interface WorkspaceSummary {
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly name: string;
  readonly entitlement: EntitlementState;
}

export interface TestSummary {
  readonly id: string;
  readonly lifecycle: TestLifecycle;
  readonly lockState: LockState | null;
  readonly workspaceId: string;
}

export const trustedIpcChannels = [
  "auth.start",
  "diagnostics.exportWithConsent",
  "test.lockIntent",
  "view.subscribe",
  "workspace.select",
] as const;

export type TrustedIpcChannel = (typeof trustedIpcChannels)[number];

export {
  fingerprintHardwareIdentifier,
  verifyGatekeeperAcceptance,
} from "./gatekeeper-acceptance.js";
export type { GatekeeperAcceptanceInput } from "./gatekeeper-acceptance.js";
export {
  createBackendHealthReader,
  INTERNAL_BASELINE_FIXTURE_DIGEST,
  observeBackend,
  parsePublicBackendConfiguration,
} from "./backend-observation.js";
export type {
  BackendHealthFetch,
  BackendHealthReader,
  BackendHealthTimeoutSignal,
  BackendObservation,
  InternalBackendEnvironment,
  PublicBackendConfiguration,
} from "./backend-observation.js";
export {
  parseTrustedGitHubOrigin,
  verifyReleaseProvenance,
} from "./release-provenance.js";
export type { ReleaseProvenanceInput } from "./release-provenance.js";
export {
  mapCreateStaffInvitationInternalResult,
  mapStaffAuthInternalFailure,
  parseAcceptStaffInvitationRequest,
  parseAcceptStaffInvitationResponse,
  parseCreateStaffInvitationRequest,
  parseCreateStaffInvitationResponse,
  parsePublicStaffAuthConfiguration,
  parseRequestStaffPasswordRecoveryRequest,
  parseRequestStaffPasswordRecoveryResponse,
  parseRevokeStaffInvitationRequest,
  parseRevokeStaffMembershipRequest,
  parseRevokeStaffInvitationResponse,
  parseRevokeStaffMembershipResponse,
  parseSelectStaffSchoolRequest,
  parseSelectStaffSchoolResponse,
  parseStaffEmailVerificationResponse,
  parseStaffLoginResponse,
  staffAuthErrorCodes,
  staffAuthProviderFailureCodes,
  staffAuthRpcFailureCodes,
  staffAuthSuccessCodes,
} from "./staff-auth.js";
export type {
  AcceptStaffInvitationRequest,
  AcceptStaffInvitationResponse,
  CreateStaffInvitationInternalResult,
  CreateStaffInvitationRequest,
  CreateStaffInvitationResponse,
  PublicStaffAuthConfiguration,
  RequestStaffPasswordRecoveryRequest,
  RequestStaffPasswordRecoveryResponse,
  RevokeStaffInvitationRequest,
  RevokeStaffInvitationResponse,
  RevokeStaffMembershipRequest,
  RevokeStaffMembershipResponse,
  SelectStaffSchoolRequest,
  SelectStaffSchoolResponse,
  StaffAuthErrorCode,
  StaffAuthInternalFailure,
  StaffAuthProviderFailureCode,
  StaffAuthRpcFailureCode,
  StaffAuthSuccessCode,
  StaffEmailVerificationResponse,
  StaffLoginResponse,
} from "./staff-auth.js";
