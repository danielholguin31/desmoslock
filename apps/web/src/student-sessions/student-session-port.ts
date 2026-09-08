import {
  parseIssueTestJoinCodeRequest,
  parsePrepareStudentReadmissionRequest,
  parseReadSchoolTestRequest,
  parseReadStudentSessionsRequest,
  parseRemoveStudentSessionRequest,
  parseStudentUuid,
} from "@desmoslock/contracts";
import type {
  IssueTestJoinCodeRequest,
  PrepareStudentReadmissionRequest,
  ReadSchoolTestRequest,
  ReadStudentSessionsRequest,
  RemoveStudentSessionRequest,
} from "@desmoslock/contracts";

export interface StudentSessionPort {
  captureStudentSessionAuthority(
    expectedAccountId: string,
    expectedProviderSessionId: string,
  ): Promise<unknown>;
  releaseStudentSessionAuthority(authorityHandle: string): void;
  readStudentTarget(
    request: ReadSchoolTestRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  readStudentSessions(
    request: ReadStudentSessionsRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  issueTestJoinCode(
    request: IssueTestJoinCodeRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  removeStudentSession(
    request: RemoveStudentSessionRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  prepareStudentReadmission(
    request: PrepareStudentReadmissionRequest,
    authorityHandle: string,
  ): Promise<unknown>;
}

interface TargetArguments {
  readonly workspace_id: string;
  readonly test_id: string;
}
interface RemovalArguments extends TargetArguments {
  readonly student_session_id: string;
  readonly expected_session_revision: number;
}
interface MaterialArguments {
  readonly issuance_request_id: string;
  readonly join_material_digest: string;
}

/** Private integration seam for the existing captured-token adapter. Each
 * closure has one fixed RPC path and the student_session_management purpose.
 * The existing adapter owns the 60-second expiry and generation fencing. */
export interface StudentSessionTransport {
  captureAuthority(
    expectedAccountId: string,
    expectedProviderSessionId: string,
  ): Promise<unknown>;
  releaseAuthority(authorityHandle: string): void;
  currentSchoolTest(
    authorityHandle: string,
    args: TargetArguments,
  ): Promise<unknown>;
  currentTestStudentSessions(
    authorityHandle: string,
    args: TargetArguments & {
      readonly before_created_at: string | null;
      readonly before_session_id: string | null;
    },
  ): Promise<unknown>;
  issueTestJoinCode(
    authorityHandle: string,
    args: TargetArguments &
      MaterialArguments & {
        readonly expected_test_revision: number;
      },
  ): Promise<unknown>;
  removeStudentSession(
    authorityHandle: string,
    args: RemovalArguments,
  ): Promise<unknown>;
  prepareStudentReadmission(
    authorityHandle: string,
    args: RemovalArguments & MaterialArguments,
  ): Promise<unknown>;
}

/** Validate and snapshot before invoking any authority-bearing transport. */
export function createStudentSessionPort(
  transport: StudentSessionTransport,
): StudentSessionPort {
  const validHandle = (handle: unknown): handle is string =>
    typeof handle === "string" && handle.length > 0 && handle.length <= 256;
  return {
    async captureStudentSessionAuthority(account, session) {
      return parseStudentUuid(account) === null ||
        parseStudentUuid(session) === null
        ? { status: "unavailable" }
        : transport.captureAuthority(account, session);
    },
    releaseStudentSessionAuthority: (handle) => {
      if (validHandle(handle)) transport.releaseAuthority(handle);
    },
    async readStudentTarget(value, handle) {
      const request = parseReadSchoolTestRequest(value);
      return request === null || !validHandle(handle)
        ? null
        : transport.currentSchoolTest(
            handle,
            Object.freeze({
              workspace_id: request.schoolId,
              test_id: request.testId,
            }),
          );
    },
    async readStudentSessions(value, handle) {
      const request = parseReadStudentSessionsRequest(value);
      return request === null || !validHandle(handle)
        ? null
        : transport.currentTestStudentSessions(
            handle,
            Object.freeze({
              workspace_id: request.schoolId,
              test_id: request.testId,
              before_created_at: request.before?.createdAt ?? null,
              before_session_id: request.before?.sessionId ?? null,
            }),
          );
    },
    async issueTestJoinCode(value, handle) {
      const request = parseIssueTestJoinCodeRequest(value);
      return request === null || !validHandle(handle)
        ? null
        : transport.issueTestJoinCode(
            handle,
            Object.freeze({
              workspace_id: request.schoolId,
              test_id: request.testId,
              expected_test_revision: request.expectedTestRevision,
              issuance_request_id: request.issuanceRequestId,
              join_material_digest: request.joinMaterialDigest,
            }),
          );
    },
    async removeStudentSession(value, handle) {
      const request = parseRemoveStudentSessionRequest(value);
      return request === null || !validHandle(handle)
        ? null
        : transport.removeStudentSession(
            handle,
            Object.freeze({
              workspace_id: request.schoolId,
              test_id: request.testId,
              student_session_id: request.studentSessionId,
              expected_session_revision: request.expectedSessionRevision,
            }),
          );
    },
    async prepareStudentReadmission(value, handle) {
      const request = parsePrepareStudentReadmissionRequest(value);
      return request === null || !validHandle(handle)
        ? null
        : transport.prepareStudentReadmission(
            handle,
            Object.freeze({
              workspace_id: request.schoolId,
              test_id: request.testId,
              student_session_id: request.studentSessionId,
              expected_session_revision: request.expectedSessionRevision,
              issuance_request_id: request.issuanceRequestId,
              join_material_digest: request.joinMaterialDigest,
            }),
          );
    },
  };
}
