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

export {
  parseClientBuildIdentity,
  parseClientBuildInputs,
  canonicalClientBuildIdentity,
  canonicalClientBuildInputs,
  parseClientUniversalBuildInputs,
  canonicalClientUniversalBuildInputs,
} from "./build-identity.js";
export type {
  ClientBuildIdentity,
  ClientBuildInputs,
  ClientUniversalBuildInputs,
} from "./build-identity.js";
export {
  parseNativeProtectionCategories,
  parseNativeProtectionFact,
  parseNativeEvidenceOriginBuild,
  parseNativeProtectionFactPrefix,
  parseStudentEvidenceRequest,
  parseStudentEvidenceResult,
  encodeNativeProtectionFactDigestInput,
  encodeStudentEvidenceBatchDigestInput,
  encodeStudentEvidenceProof,
  parseStaffStudentProtectionEvent,
  parseStudentProtectionEventPageCursor,
  parseReadStudentProtectionEventsRequest,
  parseStaffStudentProtectionEventPage,
  parseReadStudentProtectionEventsRpcResult,
} from "./native-protection-evidence.js";
export type {
  NativeProtectionFactSlot,
  NativeProtectionFactPhase,
  NativeProtectionEvent,
  NativeProtectionCause,
  NativeProtectionCategoryStatus,
  NativeProtectionCategoryCode,
  NativeProtectionCategoryObservation,
  NativeProtectionCategories,
  NativeProtectionFact,
  NativeEvidenceOriginBuild,
  StudentEvidenceRequest,
  NativeEvidenceAcknowledgment,
  StudentEvidenceAccepted,
  StudentEvidenceResult,
  StaffStudentProtectionEvent,
  StudentProtectionEventPageCursor,
  ReadStudentProtectionEventsRequest,
  StaffStudentProtectionEventPage,
  ReadStudentProtectionEventsResult,
} from "./native-protection-evidence.js";
export { parseNativeProtectionEvidenceSummary } from "./student-session.js";
export type { NativeProtectionEvidenceSummary } from "./student-session.js";

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
  STAFF_AUTH_MANAGEMENT_LIST_MAXIMUM_ITEMS,
  mapCreateStaffInvitationInternalResult,
  mapCurrentManageableStaffInvitationsRpcRows,
  mapCurrentManageableStaffRpcRows,
  mapRequestStaffPasswordRecoveryInternalResult,
  mapStaffAuthInternalFailure,
  mapStaffPasswordRecoveryRpcFailure,
  parseAcceptStaffInvitationRequest,
  parseAcceptStaffInvitationResponse,
  parseBeginStaffPasswordRecoveryOperationRequest,
  parseBeginStaffPasswordRecoveryRpcResult,
  parseChangeStaffMembershipRoleRequest,
  parseChangeStaffMembershipRoleResponse,
  parseCreateStaffInvitationRequest,
  parseCreateStaffInvitationResponse,
  parseFinishStaffPasswordRecoveryOperationRequest,
  parseFinishStaffPasswordRecoveryRpcResult,
  parseManageableStaffInvitationListResponse,
  parseManageableStaffListResponse,
  parsePublicStaffAuthConfiguration,
  parseRequestStaffPasswordRecoveryRequest,
  parseRequestStaffPasswordRecoveryResponse,
  parseRevokeStaffInvitationRequest,
  parseRevokeStaffMembershipRequest,
  parseRevokeStaffInvitationResponse,
  parseRevokeStaffMembershipResponse,
  parseSelectStaffSchoolRequest,
  parseSelectStaffSchoolResponse,
  parseStaffDisplayName,
  parseStaffEmailVerificationResponse,
  parseStaffLoginResponse,
  parseStaffPasswordRecoveryCompletionResponse,
  staffAuthErrorCodes,
  staffAuthProviderFailureCodes,
  staffAuthRpcFailureCodes,
  staffAuthWireSuccessCodes,
  staffPasswordRecoveryDownstreamOutcomes,
  staffPasswordRecoveryRpcFailureCodes,
} from "./staff-auth.js";
export type {
  AcceptStaffInvitationRequest,
  AcceptStaffInvitationResponse,
  BeginStaffPasswordRecoveryRpcResult,
  ChangeStaffMembershipRoleRequest,
  ChangeStaffMembershipRoleResponse,
  CreateStaffInvitationInternalResult,
  CreateStaffInvitationRequest,
  CreateStaffInvitationResponse,
  FinishStaffPasswordRecoveryRpcResult,
  ManageableStaffInvitation,
  ManageableStaffInvitationListResponse,
  ManageableStaffListResponse,
  ManageableStaffMember,
  PublicStaffAuthConfiguration,
  RequestStaffPasswordRecoveryInternalResult,
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
  StaffAuthWireSuccessCode,
  StaffEmailVerificationResponse,
  StaffLoginResponse,
  StaffPasswordRecoveryCompletionResponse,
  StaffPasswordRecoveryDownstreamOutcome,
  StaffPasswordRecoveryOperationRequest,
  StaffPasswordRecoveryRpcFailureCode,
} from "./staff-auth.js";
export {
  parseSchoolDisplayName,
  parseSchoolSettings,
  parseUpdateSchoolDisplayNameRequest,
  parseUpdateSchoolDisplayNameRpcResult,
  updateSchoolDisplayNameRpcFailureCodes,
  updateSchoolDisplayNameRpcSuccessCodes,
  validateSchoolDisplayNameDraft,
} from "./school-settings.js";
export type {
  SchoolDisplayNameDraftValidation,
  SchoolNameValidation,
  SchoolSettings,
  UpdateSchoolDisplayNameRequest,
  UpdateSchoolDisplayNameRpcFailureCode,
  UpdateSchoolDisplayNameRpcResult,
  UpdateSchoolDisplayNameRpcSuccessCode,
} from "./school-settings.js";
export {
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
} from "./test-workspace.js";
export type {
  CreateSchoolTestRequest,
  CreateSchoolTestResult,
  EndTestResult,
  OpenTestResult,
  ReadSchoolTestRequest,
  ReadSchoolTestResult,
  ReadSchoolTestsRequest,
  ReadSchoolTestsResult,
  StaffTest,
  StaffTestPage,
  TestAccessFailureCode,
  TestLifecycle,
  TestMutationFailureCode,
  TestPageCursor,
  TestRevisionRequest,
  TestRevisionResult,
  TestTargetFailureCode,
  TestTitleDraftValidation,
  TestTitleValidation,
  UpdateTestTitleRequest,
  UpdateTestTitleResult,
} from "./test-workspace.js";

export {
  parseIssueTestJoinCodeRequest,
  parseIssueTestJoinCodeRpcResult,
  parsePrepareStudentReadmissionRequest,
  parsePrepareStudentReadmissionRpcResult,
  parseReadStudentSessionsRequest,
  parseReadStudentSessionsRpcResult,
  parseRemoveStudentSessionRequest,
  parseRemoveStudentSessionRpcResult,
  parseStaffStudentSession,
  parseStaffStudentSessionPage,
  parseStudentBootstrapProof,
  parseStudentChallengeRequest,
  parseStudentChallengeResult,
  parseStudentCounter,
  parseStudentDigest,
  parseStudentForfeitRequest,
  parseStudentForfeitResult,
  parseStudentJoinCode,
  parseStudentJoinRequest,
  parseStudentJoinResult,
  parseStudentMaintenanceProof,
  parseStudentPublicKey,
  parseStudentReadRequest,
  parseStudentReadResult,
  parseStudentReconnectRequest,
  parseStudentReconnectResult,
  parseStudentSecret,
  parseStudentSessionFailure,
  parseStudentSessionPageCursor,
  parseStudentSessionScope,
  parseStudentSessionViewState,
  parseStudentSignature,
  parseStudentTimestamp,
  parseStudentUuid,
} from "./student-session.js";

export type {
  IssueTestJoinCodeRequest,
  IssueTestJoinCodeResult,
  PrepareStudentReadmissionRequest,
  PrepareStudentReadmissionResult,
  ReadStudentSessionsRequest,
  ReadStudentSessionsResult,
  RemoveStudentSessionRequest,
  RemoveStudentSessionResult,
  StaffStudentSession,
  StaffStudentSessionPage,
  StudentAdmissionMode,
  StudentAdmissionState,
  StudentBootstrapProof,
  StudentChallengeAccepted,
  StudentChallengeRequest,
  StudentChallengeResult,
  StudentForfeitAccepted,
  StudentForfeitRequest,
  StudentForfeitResult,
  StudentJoinAccepted,
  StudentJoinRequest,
  StudentJoinResult,
  StudentMaintenanceProof,
  StudentReadAccepted,
  StudentReadRequest,
  StudentReadResult,
  StudentReconnectAccepted,
  StudentReconnectRequest,
  StudentReconnectResult,
  StudentSessionAccessFailureCode,
  StudentSessionDenied,
  StudentSessionFailure,
  StudentSessionMutationFailureCode,
  StudentSessionPageCursor,
  StudentSessionScope,
  StudentSessionUnavailable,
  StudentSessionViewState,
} from "./student-session.js";

export {
  STUDENT_AUTHORITY_DIGEST_DOMAINS,
  decodeStudentSecretBytes,
  encodeStudentLogicalOperation,
  encodeStudentMaterialDigestInput,
  encodeStudentProofBytes,
  encodeStudentProofEnvelope,
  parseStudentProofOrigin,
} from "./student-session-proof.js";

export type {
  StudentBootstrapEnvelope,
  StudentLogicalOperation,
  StudentMaintenanceEnvelope,
  StudentMaintenanceOperation,
} from "./student-session-proof.js";
