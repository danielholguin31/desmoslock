import {
  mapCurrentManageableStaffInvitationsRpcRows,
  mapCurrentManageableStaffRpcRows,
  mapStaffAuthInternalFailure,
  parseAcceptStaffInvitationRequest,
  parseAcceptStaffInvitationResponse,
  parseBeginStaffPasswordRecoveryRpcResult,
  parseChangeStaffMembershipRoleRequest,
  parseChangeStaffMembershipRoleResponse,
  parseCreateStaffInvitationRequest,
  parseCreateStaffInvitationResponse,
  parseFinishStaffPasswordRecoveryRpcResult,
  parseManageableStaffInvitationListResponse,
  parseManageableStaffListResponse,
  parseRequestStaffPasswordRecoveryRequest,
  parseRequestStaffPasswordRecoveryResponse,
  parseRevokeStaffInvitationRequest,
  parseRevokeStaffInvitationResponse,
  parseRevokeStaffMembershipRequest,
  parseRevokeStaffMembershipResponse,
  parseSchoolDisplayName,
  parseStaffDisplayName,
  staffAuthRpcFailureCodes,
  type AcceptStaffInvitationRequest,
  type BeginStaffPasswordRecoveryRpcResult,
  type ChangeStaffMembershipRoleRequest,
  type CreateStaffInvitationRequest,
  type FinishStaffPasswordRecoveryRpcResult,
  type ManageableStaffInvitation,
  type ManageableStaffMember,
  type RequestStaffPasswordRecoveryRequest,
  type RevokeStaffInvitationRequest,
  type RevokeStaffMembershipRequest,
  type UpdateSchoolDisplayNameRequest,
} from "@desmoslock/contracts";

import type { TestWorkspacePort } from "../test-workspace/test-workspace-controller.js";
import type {
  StaffAuthAccessGrant,
  StaffAuthAccessEvent,
  StaffAuthAdapter,
  StaffAuthBoundaryIdentity,
  StaffAuthBoundaryManagedInvitation,
  StaffAuthBoundaryManagedStaff,
  StaffAuthBoundaryResult,
  StaffAuthMutation,
  StaffAuthMutationResult,
  StaffAuthOperationIdSource,
} from "./staff-auth-controller.js";

export interface SupabaseStaffAuthPort extends TestWorkspacePort {
  captureSchoolSettingsAuthority(
    expectedAccountId: string,
    expectedProviderSessionId: string,
  ): Promise<unknown>;
  releaseSchoolSettingsAuthority(authorityHandle: string): void;
  updateSchoolDisplayName(
    request: UpdateSchoolDisplayNameRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  capturePasswordAuthority(): Promise<string | null>;
  capturePasswordAuthority(
    expectedAccountId: string,
    expectedProviderSessionId: string,
  ): Promise<string | null>;
  captureSignOutAuthority(
    expectedAccountId: string,
    expectedProviderSessionId: string,
  ): Promise<unknown>;
  captureStaffManagementAuthority(
    expectedAccountId: string,
    expectedProviderSessionId: string,
  ): Promise<unknown>;
  releaseStaffManagementAuthority(authorityHandle: string): void;
  changeMembershipRole(
    request: ChangeStaffMembershipRoleRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  clearPrivateAuthContinuations(): void;
  releasePasswordAuthority(authorityHandle: string): void;
  acceptInvitation(
    request: AcceptStaffInvitationRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  beginPasswordRecovery(
    operationId: string,
    authorityHandle: string,
  ): Promise<unknown>;
  challengeTotp(factorId: string): Promise<unknown>;
  enrollTotp(): Promise<unknown>;
  exchangeEmailVerificationCode(input: {
    readonly authorizationCode: string;
    readonly flowId: string;
  }): Promise<unknown>;
  exchangeRecoveryCode(input: {
    readonly authorizationCode: string;
    readonly verifier: string;
  }): Promise<unknown>;
  finishPasswordRecovery(
    operationId: string,
    authorityHandle: string,
  ): Promise<unknown>;
  invokeInvitation(
    request: CreateStaffInvitationRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  invokeRecovery(
    request: RequestStaffPasswordRecoveryRequest,
  ): Promise<unknown>;
  onAuthStateChange(listener: () => void): () => void;
  readAccount(): Promise<unknown>;
  readAssurance(): Promise<unknown>;
  readCurrentContext(): Promise<unknown>;
  readCurrentInvitations(): Promise<unknown>;
  readManageableInvitations(): Promise<unknown>;
  readManageableStaff(): Promise<unknown>;
  readSession(): Promise<unknown>;
  readTotpFactors(): Promise<unknown>;
  removeTotpFactor(factorId: string): Promise<unknown>;
  resendEmailVerification(email: string): Promise<unknown>;
  revokeAllStaffSessions(authorityHandle: string): Promise<unknown>;
  revokeCurrentStaffSession(authorityHandle: string): Promise<unknown>;
  revokeInvitation(
    request: RevokeStaffInvitationRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  revokeMembership(
    request: RevokeStaffMembershipRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  signIn(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<unknown>;
  signOut(scope: "all" | "local", authorityHandle: string): Promise<unknown>;
  updatePassword(password: string, authorityHandle: string): Promise<unknown>;
  verifyInvitationToken(tokenHash: string): Promise<unknown>;
  verifyTotp(input: {
    readonly challengeId: string;
    readonly code: string;
    readonly factorId: string;
  }): Promise<unknown>;
}

export type SupabaseStaffAuthAdapter = StaffAuthAdapter & {
  dispose(): void;
};

export function createSupabaseStaffAuthAdapter(dependencies: {
  readonly clock: { readonly now: () => number };
  readonly createBlobUrl: (blob: Blob) => string;
  readonly operationIds: StaffAuthOperationIdSource;
  readonly port: SupabaseStaffAuthPort;
  readonly revokeBlobUrl: (url: string) => void;
}): SupabaseStaffAuthAdapter {
  let disposed = false;
  let sessionGeneration: string | null = null;
  let providerSessionId: string | null = null;
  let identityGeneration: string | null = null;
  let identityFacts: IdentityFacts | null = null;
  let schoolPresentation: {
    readonly identityGeneration: string;
    readonly sessionGeneration: string;
    readonly assuranceLevel: StaffAuthAccessGrant["assuranceLevel"];
    readonly secondFactor: StaffAuthAccessGrant["secondFactor"];
    readonly school: StaffAuthBoundaryIdentity["school"];
  } | null = null;
  let pendingVerificationEmail: string | null = null;
  // Route intent only. Every ready projection still verifies the port's private
  // original recovery binding; this object carries no provider authority.
  let recoveryContinuation: { ready: boolean } | null = null;
  const challengeReceipts = new Map<string, ChallengeReceipt>();
  const enrollmentReceipts = new Map<string, EnrollmentReceipt>();
  const invitationInspectionContinuations = new Map<
    string,
    InvitationInspectionContinuation
  >();
  const invitationReceipts = new Map<string, InvitationReceipt>();
  const listeners = new Set<(event: StaffAuthAccessEvent) => void>();
  const activePresentations = new Set<RevocablePresentation>();
  const completedOperations = new Map<string, CompletedOperation>();
  const inFlightOperations = new Map<
    string,
    {
      readonly promise: Promise<StaffAuthMutationResult>;
      readonly requestIdentity: string | null;
      readonly type: string;
    }
  >();
  let eventRevision = 0;
  let processedEventRevision = 0;
  let authorityRead: Promise<StaffAuthBoundaryResult> | null = null;
  let activeMutations = 0;
  const mutationWaiters = new Set<() => void>();

  function nextGeneration(): string {
    const generation = dependencies.operationIds.next();
    if (!validText(generation, 256)) {
      throw new Error("Staff authentication generation is unavailable");
    }
    return generation;
  }

  function revokePresentation(presentation: RevocablePresentation): void {
    if (presentation.revoked) {
      return;
    }
    presentation.revoked = true;
    activePresentations.delete(presentation);
    try {
      dependencies.revokeBlobUrl(presentation.blobUrl);
    } catch {
      // Object URL revocation is best-effort and never affects authorization.
    }
  }

  function removeEnrollmentReceipt(
    receiptId: string,
    removeFactor: boolean,
  ): void {
    const receipt = enrollmentReceipts.get(receiptId);
    if (receipt === undefined) {
      return;
    }
    enrollmentReceipts.delete(receiptId);
    revokePresentation(receipt.presentation);
    if (removeFactor) {
      void dependencies.port
        .removeTotpFactor(receipt.factorId)
        .catch(() => undefined);
    }
  }

  function clearEnrollmentReceipts(removeFactors: boolean): void {
    for (const receiptId of [...enrollmentReceipts.keys()]) {
      removeEnrollmentReceipt(receiptId, removeFactors);
    }
  }

  function clearAuthorityState(removeEnrollmentFactors = true): void {
    sessionGeneration = null;
    providerSessionId = null;
    identityGeneration = null;
    identityFacts = null;
    schoolPresentation = null;
    invitationInspectionContinuations.clear();
    challengeReceipts.clear();
    clearEnrollmentReceipts(removeEnrollmentFactors);
  }

  async function readAuthority(
    options: { readonly rotateSession?: boolean } = {},
  ): Promise<StaffAuthBoundaryResult> {
    try {
      const result = await readAuthorityResult(options);
      if (disposed) throw new Error("Staff authentication adapter is disposed");
      if (result.kind !== "access_granted") {
        schoolPresentation = null;
        return result;
      }
      const current = result.identity.school;
      const previous = schoolPresentation;
      let school = current;
      if (
        previous !== null &&
        previous.identityGeneration === result.identityGeneration &&
        previous.sessionGeneration === result.sessionGeneration &&
        previous.assuranceLevel === result.assuranceLevel &&
        previous.secondFactor === result.secondFactor &&
        previous.school.id === current.id
      ) {
        if (
          current.settingsRevision === previous.school.settingsRevision &&
          current.label !== previous.school.label
        ) {
          throw new Error("School presentation revision is inconsistent");
        }
        if (current.settingsRevision < previous.school.settingsRevision) {
          school = previous.school;
        }
      }
      schoolPresentation = {
        identityGeneration: result.identityGeneration,
        sessionGeneration: result.sessionGeneration,
        assuranceLevel: result.assuranceLevel,
        secondFactor: result.secondFactor,
        school: { ...school },
      };
      return school === current
        ? result
        : {
            ...result,
            identity: { ...result.identity, school: { ...school } },
          };
    } catch (error: unknown) {
      schoolPresentation = null;
      throw error;
    }
  }

  async function readAuthorityResult(
    options: { readonly rotateSession?: boolean } = {},
  ): Promise<StaffAuthBoundaryResult> {
    const continuation = recoveryContinuation;
    if (continuation !== null) {
      if (!continuation.ready) return { kind: "password_recovery_rejected" };
      let authorityHandle: string | null = null;
      try {
        authorityHandle = await dependencies.port.capturePasswordAuthority();
      } finally {
        if (authorityHandle !== null) {
          dependencies.port.releasePasswordAuthority(authorityHandle);
        }
      }
      if (continuation !== recoveryContinuation) {
        return { kind: "password_recovery_rejected" };
      }
      continuation.ready = authorityHandle !== null;
      return {
        kind: continuation.ready
          ? "password_recovery_ready"
          : "password_recovery_rejected",
      };
    }
    const session = snapshotExactRecord(await dependencies.port.readSession(), [
      "status",
    ]);
    if (session?.status === "signed_out") {
      clearAuthorityState(false);
      invitationReceipts.clear();
      return { kind: "signed_out" };
    }
    if (session?.status !== "authenticated") {
      throw new Error("Staff authentication session result is unavailable");
    }
    const accountResult = await dependencies.port.readAccount();
    if (decodeStatus(accountResult, ["signed_out"]) === "signed_out") {
      clearAuthorityState(false);
      invitationReceipts.clear();
      return { kind: "signed_out" };
    }
    const account = decodeAccount(accountResult);
    if (account === null) {
      throw new Error("Staff authentication account result is unavailable");
    }
    if (
      providerSessionId !== null &&
      providerSessionId !== account.providerSessionId
    ) {
      // Old enrollment cleanup must never select the replacement SDK session.
      clearEnrollmentReceipts(false);
    }
    const candidateSessionGeneration =
      sessionGeneration === null ||
      options.rotateSession === true ||
      providerSessionId !== account.providerSessionId
        ? nextGeneration()
        : sessionGeneration;
    if (!account.emailVerified) {
      sessionGeneration = candidateSessionGeneration;
      providerSessionId = account.providerSessionId;
      identityGeneration = null;
      identityFacts = null;
      challengeReceipts.clear();
      clearEnrollmentReceipts(true);
      return { kind: "email_verification_required" };
    }

    const context = decodeCurrentContext(
      await dependencies.port.readCurrentContext(),
    );
    if (context.kind !== "active") {
      sessionGeneration = candidateSessionGeneration;
      providerSessionId = account.providerSessionId;
      identityGeneration = null;
      identityFacts = null;
      challengeReceipts.clear();
      clearEnrollmentReceipts(true);
      if (context.kind === "membership_inactive") {
        const invitation = decodeCurrentInvitation(
          await dependencies.port.readCurrentInvitations(),
        );
        if (
          invitation.kind === "ready" &&
          invitation.expiresAtMilliseconds > readNow(dependencies.clock)
        ) {
          return projectInvitation(account, invitation, nextGeneration());
        }
      }
      return { kind: context.kind };
    }
    const assurance = decodeAssurance(await dependencies.port.readAssurance());
    if (assurance === null) {
      throw new Error("Staff authentication assurance result is unavailable");
    }

    const facts: IdentityFacts = {
      accountId: account.accountId,
      displayName: context.displayName,
      email: account.email,
      profileId: context.profileId,
      role: context.role,
      roleRevision: context.roleRevision,
      schoolId: context.schoolId,
    };
    const identityChanged =
      identityFacts === null || !sameIdentityFacts(identityFacts, facts);
    const sessionChanged = candidateSessionGeneration !== sessionGeneration;
    const candidateIdentityGeneration =
      identityGeneration === null || identityChanged
        ? nextGeneration()
        : identityGeneration;

    const identity: StaffAuthBoundaryIdentity = {
      accountId: account.accountId,
      email: account.email,
      membership: {
        id: `${context.schoolId}:${context.profileId}`,
        role: context.role,
        status: "active",
      },
      profile: {
        displayName: context.displayName,
        id: context.profileId,
      },
      school: {
        id: context.schoolId,
        label: context.schoolLabel,
        settingsRevision: context.schoolSettingsRevision,
      },
    };
    let manageableInvitations: StaffAuthBoundaryManagedInvitation[] = [];
    let manageableStaff: StaffAuthBoundaryManagedStaff[] = [];
    if (
      (context.role === "owner" || context.role === "admin") &&
      assurance.currentLevel === "aal2"
    ) {
      const [rawStaff, rawInvitations] = await Promise.all([
        dependencies.port.readManageableStaff(),
        dependencies.port.readManageableInvitations(),
      ]);
      const staff = parseManageableStaffListResponse(
        mapCurrentManageableStaffRpcRows(rawStaff),
      );
      const invitations = parseManageableStaffInvitationListResponse(
        mapCurrentManageableStaffInvitationsRpcRows(rawInvitations),
      );
      if (staff === null || invitations === null) {
        throw new Error("Staff management result is malformed");
      }
      if (!staff.ok) {
        return managementFailure(staff.code);
      }
      if (!invitations.ok) {
        return managementFailure(invitations.code);
      }
      if (
        context.role === "admin" &&
        (staff.items.some((entry) => entry.role !== "teacher") ||
          invitations.items.some((entry) => entry.role !== "teacher"))
      ) {
        throw new Error("Administrator staff management result is malformed");
      }
      manageableStaff = staff.items
        .filter((entry) => entry.schoolId === context.schoolId)
        .map(mapManagedStaff);
      manageableInvitations = invitations.items
        .filter((entry) => entry.schoolId === context.schoolId)
        .map(mapManagedInvitation);
    }
    const base: Omit<
      StaffAuthAccessGrant,
      "challengeReceipt" | "factorChoices" | "secondFactor"
    > = {
      assuranceLevel: assurance.currentLevel,
      identity,
      identityGeneration: candidateIdentityGeneration,
      kind: "access_granted",
      manageableInvitations,
      manageableStaff,
      providerSessionId: account.providerSessionId,
      sessionGeneration: candidateSessionGeneration,
    };
    let result: StaffAuthAccessGrant;
    let pendingChallenges: Array<{
      readonly factorId: string;
      readonly receipt: string;
    }> = [];
    if (context.role === "teacher" || assurance.currentLevel === "aal2") {
      result = { ...base, secondFactor: "satisfied" };
    } else {
      const factors = decodeTotpFactors(
        await dependencies.port.readTotpFactors(),
      );
      if (factors === null) {
        throw new Error("Staff authentication factors are unavailable");
      }
      const verified = factors.filter((factor) => factor.status === "verified");
      if (verified.length === 0) {
        result = { ...base, secondFactor: "enrollment_required" };
      } else {
        if (assurance.nextLevel !== "aal2") {
          throw new Error("Privileged staff assurance is unavailable");
        }
        pendingChallenges = verified.map((factor) => ({
          factorId: factor.factorId,
          receipt: nextGeneration(),
        }));
        const firstChallenge = pendingChallenges[0];
        const firstFactor = verified[0];
        if (firstChallenge === undefined || firstFactor === undefined) {
          throw new Error("Staff authentication factor is unavailable");
        }
        result =
          verified.length === 1
            ? {
                ...base,
                challengeReceipt: firstChallenge.receipt,
                secondFactor: "challenge_required",
              }
            : {
                ...base,
                factorChoices: verified.map((factor, index) => ({
                  challengeReceipt: pendingChallenges[index]!.receipt,
                  label: factorChoiceLabel(factor.friendlyName, index),
                })),
                secondFactor: "factor_selection_required",
              };
      }
    }
    if (identityChanged || sessionChanged) {
      challengeReceipts.clear();
      clearEnrollmentReceipts(true);
    }
    for (const pendingChallenge of pendingChallenges) {
      challengeReceipts.set(pendingChallenge.receipt, {
        expiresAt: readNow(dependencies.clock) + 5 * 60 * 1000,
        factorId: pendingChallenge.factorId,
        identityGeneration: candidateIdentityGeneration,
        sessionGeneration: candidateSessionGeneration,
      });
    }
    trimMap(challengeReceipts, 16);
    sessionGeneration = candidateSessionGeneration;
    providerSessionId = account.providerSessionId;
    identityGeneration = candidateIdentityGeneration;
    identityFacts = facts;
    return result;
  }

  async function performMutation(
    request: StaffAuthMutation,
  ): Promise<StaffAuthMutationResult> {
    if (!isCanonicalUuid(request.operationId)) {
      throw new Error("Staff authentication operation is invalid");
    }
    let result: StaffAuthBoundaryResult;
    if (
      request.type === "sign_in" ||
      request.type === "exchange_email_verification_code" ||
      request.type === "request_password_recovery" ||
      request.type === "exchange_recovery_code" ||
      request.type === "complete_password_recovery" ||
      request.type === "inspect_invitation" ||
      request.type === "sign_out" ||
      request.type === "reset_to_sign_in"
    ) {
      recoveryContinuation = null;
    }
    if (request.type === "sign_in") {
      if (!isCanonicalEmail(request.email) || !isPassword(request.password)) {
        result = { kind: "sign_in_rejected" };
      } else {
        const response = decodeStatus(
          await dependencies.port.signIn({
            email: request.email,
            password: request.password,
          }),
          ["authenticated", "email_verification_required", "rejected"],
        );
        if (response === null) {
          throw new Error("Staff sign-in result is unavailable");
        }
        if (response === "email_verification_required") {
          pendingVerificationEmail = request.email;
          result = { kind: "email_verification_required" };
        } else if (response === "rejected") {
          pendingVerificationEmail = null;
          result = { kind: "sign_in_rejected" };
        } else {
          pendingVerificationEmail = null;
          result = await readAuthority();
        }
      }
    } else if (request.type === "resend_email_verification") {
      const email = pendingVerificationEmail;
      if (email === null) {
        throw new Error("Email verification recipient is unavailable");
      }
      const response = decodeStatus(
        await dependencies.port.resendEmailVerification(email),
        ["sent"],
      );
      if (response !== "sent") {
        throw new Error("Email verification result is unavailable");
      }
      result = { kind: "email_verification_sent" };
    } else if (request.type === "exchange_email_verification_code") {
      if (
        !validOpaqueCredential(request.authorizationCode, 2048) ||
        !/^[A-Za-z0-9_-]{8,64}$/u.test(request.flowId)
      ) {
        result = { kind: "email_verification_callback_rejected" };
      } else {
        const response = decodeStatus(
          await dependencies.port.exchangeEmailVerificationCode({
            authorizationCode: request.authorizationCode,
            flowId: request.flowId,
          }),
          ["ready", "rejected"],
        );
        if (response === null) {
          throw new Error("Email verification callback is unavailable");
        }
        result =
          response === "rejected"
            ? { kind: "email_verification_callback_rejected" }
            : await readAuthority({ rotateSession: true });
      }
    } else if (request.type === "request_password_recovery") {
      const recoveryRequest = parseRequestStaffPasswordRecoveryRequest({
        codeChallenge: request.codeChallenge,
        email: request.email,
        flowId: request.flowId,
        state: request.state,
      });
      if (recoveryRequest === null) {
        throw new Error("Password recovery request is invalid");
      }
      const response = parseRequestStaffPasswordRecoveryResponse(
        await dependencies.port.invokeRecovery(recoveryRequest),
      );
      if (response === null || !response.ok) {
        throw new Error("Password recovery request is unavailable");
      }
      result = { kind: "recovery_request_received" };
    } else if (request.type === "exchange_recovery_code") {
      const continuation = { ready: false };
      recoveryContinuation = continuation;
      if (
        !validOpaqueCredential(request.authorizationCode, 2048) ||
        !isBase64Url(request.verifier, 43)
      ) {
        result = { kind: "password_recovery_rejected" };
      } else {
        const response = decodeStatus(
          await dependencies.port.exchangeRecoveryCode({
            authorizationCode: request.authorizationCode,
            verifier: request.verifier,
          }),
          ["ready", "rejected"],
        );
        if (response === null) {
          throw new Error("Password recovery callback is unavailable");
        }
        const ready =
          continuation === recoveryContinuation && response === "ready";
        continuation.ready = ready;
        result = {
          kind: ready
            ? "password_recovery_ready"
            : "password_recovery_rejected",
        };
      }
    } else if (request.type === "complete_password_recovery") {
      result = await completePasswordRecovery(
        request.operationId,
        request.password,
      );
    } else if (request.type === "inspect_invitation") {
      result = await inspectInvitation(request.operationId, request.tokenHash);
    } else if (request.type === "resume_invitation_inspection") {
      result = await resumeInvitationInspection(request);
    } else if (request.type === "accept_invitation") {
      result = await acceptInvitation(request);
    } else if (request.type === "begin_totp_enrollment") {
      result = await beginTotpEnrollment(request.operationId);
    } else if (request.type === "verify_totp") {
      result = await verifyTotpMutation(request);
    } else if (request.type === "sign_out") {
      result = await signOut(request.scope);
    } else if (request.type === "reset_to_sign_in") {
      result = await resetToSignIn();
    } else if (request.type === "create_staff_invitation") {
      result = await createStaffInvitation(request);
    } else if (request.type === "revoke_staff_invitation") {
      result = await revokeStaffInvitation(request);
    } else if (request.type === "revoke_staff_membership") {
      result = await revokeStaffMembership(request);
    } else if (request.type === "change_staff_membership_role") {
      result = await changeStaffMembershipRole(request);
    } else {
      throw new Error("Staff authentication mutation is unavailable");
    }
    return { operationId: request.operationId, result };
  }

  async function inspectInvitation(
    inspectionOperationId: string,
    tokenHash: string,
  ): Promise<StaffAuthBoundaryResult> {
    if (!/^[0-9a-f]{56}$/u.test(tokenHash)) {
      return { kind: "invitation_rejected", reason: "invalid" };
    }
    const verification = decodeInvitationVerification(
      await dependencies.port.verifyInvitationToken(tokenHash),
    );
    if (verification === null) {
      throw new Error("Invitation verification result is malformed");
    }
    if (verification.status !== "verified") {
      return {
        kind: "invitation_rejected",
        reason: verification.status,
      };
    }
    const continuationReceipt = nextGeneration();
    const continuation: InvitationInspectionContinuation = {
      accountId: verification.accountId,
      continuationReceipt,
      expiresAt: readNow(dependencies.clock) + 5 * 60 * 1000,
      identityGeneration: nextGeneration(),
      inspectionOperationId,
      sessionGeneration: nextGeneration(),
    };
    if (invitationInspectionContinuations.has(continuationReceipt)) {
      throw new Error("Invitation continuation generation collided");
    }
    invitationInspectionContinuations.set(continuationReceipt, continuation);
    trimMap(invitationInspectionContinuations, 16);
    sessionGeneration = continuation.sessionGeneration;
    identityGeneration = continuation.identityGeneration;
    identityFacts = null;
    return continueInvitationInspection(continuation);
  }

  async function resumeInvitationInspection(
    request: Extract<
      StaffAuthMutation,
      { readonly type: "resume_invitation_inspection" }
    >,
  ): Promise<StaffAuthBoundaryResult> {
    const continuation = invitationInspectionContinuations.get(
      request.continuationReceipt,
    );
    if (
      continuation === undefined ||
      continuation.inspectionOperationId !== request.inspectionOperationId ||
      continuation.continuationReceipt !== request.continuationReceipt
    ) {
      return { kind: "invitation_rejected", reason: "invalid" };
    }
    return continueInvitationInspection(continuation);
  }

  async function continueInvitationInspection(
    continuation: InvitationInspectionContinuation,
  ): Promise<StaffAuthBoundaryResult> {
    const interrupted = (): StaffAuthBoundaryResult => ({
      continuationReceipt: continuation.continuationReceipt,
      inspectionOperationId: continuation.inspectionOperationId,
      kind: "invitation_inspection_interrupted",
    });
    let now: number;
    try {
      now = readNow(dependencies.clock);
    } catch {
      return interrupted();
    }
    if (continuation.expiresAt <= now) {
      invitationInspectionContinuations.delete(
        continuation.continuationReceipt,
      );
      return { kind: "invitation_rejected", reason: "expired" };
    }
    if (
      sessionGeneration !== continuation.sessionGeneration ||
      identityGeneration !== continuation.identityGeneration
    ) {
      invitationInspectionContinuations.delete(
        continuation.continuationReceipt,
      );
      return { kind: "invitation_rejected", reason: "invalid" };
    }

    let rawSession: unknown;
    let rawAccount: unknown;
    try {
      rawSession = await dependencies.port.readSession();
      rawAccount = await dependencies.port.readAccount();
    } catch {
      return interrupted();
    }
    const session = decodeStatus(rawSession, ["authenticated", "signed_out"]);
    if (session === null || rawAccount === null) {
      return interrupted();
    }
    const account = decodeAccount(rawAccount);
    if (
      session !== "authenticated" ||
      account === null ||
      !account.emailVerified ||
      account.accountId !== continuation.accountId
    ) {
      clearAuthorityState();
      return { kind: "invitation_rejected", reason: "invalid" };
    }

    let invitation: CurrentInvitationResult;
    try {
      invitation = decodeCurrentInvitation(
        await dependencies.port.readCurrentInvitations(),
      );
    } catch {
      return interrupted();
    }
    if (invitation.kind !== "ready") {
      invitationInspectionContinuations.delete(
        continuation.continuationReceipt,
      );
      return { kind: "invitation_rejected", reason: invitation.reason };
    }
    if (invitation.expiresAtMilliseconds <= now) {
      invitationInspectionContinuations.delete(
        continuation.continuationReceipt,
      );
      return { kind: "invitation_rejected", reason: "expired" };
    }
    invitationInspectionContinuations.delete(continuation.continuationReceipt);
    return projectInvitation(
      account,
      invitation,
      continuation.inspectionOperationId,
    );
  }

  function projectInvitation(
    account: { readonly accountId: string; readonly email: string },
    invitation: Extract<CurrentInvitationResult, { readonly kind: "ready" }>,
    inspectionOperationId: string,
  ): StaffAuthBoundaryResult {
    const acceptanceReceipt = nextGeneration();
    if (invitationReceipts.has(acceptanceReceipt)) {
      throw new Error("Invitation receipt generation collided");
    }
    invitationReceipts.set(acceptanceReceipt, {
      accountId: account.accountId,
      email: account.email,
      expiresAt: invitation.expiresAtMilliseconds,
      inspectionOperationId,
      invitationId: invitation.invitationId,
      role: invitation.role,
      schoolId: invitation.schoolId,
      schoolLabel: invitation.schoolLabel,
    });
    trimMap(invitationReceipts, 16);
    return {
      acceptanceReceipt,
      expiresAt: invitation.expiresAt,
      inspectionOperationId,
      intendedAccountId: account.accountId,
      intendedEmail: account.email,
      kind: "invitation_ready",
      role: invitation.role,
      school: { id: invitation.schoolId, label: invitation.schoolLabel },
    };
  }

  async function acceptInvitation(
    request: Extract<StaffAuthMutation, { readonly type: "accept_invitation" }>,
  ): Promise<StaffAuthBoundaryResult> {
    const receipt = invitationReceipts.get(request.acceptanceReceipt);
    if (
      receipt === undefined ||
      receipt.inspectionOperationId !== request.inspectionOperationId ||
      receipt.expiresAt <= readNow(dependencies.clock)
    ) {
      invitationReceipts.delete(request.acceptanceReceipt);
      return { kind: "invitation_rejected", reason: "invalid" };
    }
    const session = decodeStatus(await dependencies.port.readSession(), [
      "authenticated",
    ]);
    const account = decodeAccount(await dependencies.port.readAccount());
    if (
      session !== "authenticated" ||
      account === null ||
      !account.emailVerified ||
      account.accountId !== receipt.accountId ||
      account.email !== receipt.email
    ) {
      invitationReceipts.delete(request.acceptanceReceipt);
      return { kind: "invitation_rejected", reason: "invalid" };
    }
    const acceptance = parseAcceptStaffInvitationRequest({
      displayName: request.displayName,
      invitationId: receipt.invitationId,
    });
    if (acceptance === null || !isPassword(request.password)) {
      return { kind: "invitation_rejected", reason: "invalid" };
    }
    const initiatingRevision = eventRevision;
    const initiatingProviderSessionId = account.providerSessionId;
    const authorityHandle = await dependencies.port.capturePasswordAuthority(
      receipt.accountId,
      initiatingProviderSessionId,
    );
    if (authorityHandle === null)
      return { kind: "invitation_rejected", reason: "invalid" };
    try {
      async function sameRecipient(): Promise<boolean> {
        if (eventRevision !== initiatingRevision) return false;
        try {
          const currentSession = decodeStatus(
            await dependencies.port.readSession(),
            ["authenticated"],
          );
          const currentAccount = decodeAccount(
            await dependencies.port.readAccount(),
          );
          return (
            eventRevision === initiatingRevision &&
            currentSession === "authenticated" &&
            currentAccount?.emailVerified === true &&
            currentAccount.accountId === receipt!.accountId &&
            currentAccount.providerSessionId === initiatingProviderSessionId &&
            currentAccount.email === receipt!.email
          );
        } catch {
          return false;
        }
      }
      let response: ReturnType<typeof parseAcceptStaffInvitationResponse> =
        null;
      // The database owns acceptance. An absent response is reconciled against
      // canonical authority, then retried once with the identical nonsecret intent.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!(await sameRecipient())) break;
        try {
          response = parseAcceptStaffInvitationResponse(
            productRpcResponse(
              exactSingleRow(
                await dependencies.port.acceptInvitation(
                  acceptance,
                  authorityHandle,
                ),
              ),
              "invitation_accepted",
            ),
          );
        } catch {
          // Provider/transport diagnostics must never cross the browser boundary.
        }
        if (response !== null) break;
        try {
          const authority = await readAuthority();
          if (matchesAcceptedInvitation(authority, receipt)) {
            response = { ok: true, code: "invitation_accepted" };
            break;
          }
        } catch {
          // Missing reconciliation evidence is still an unknown acceptance result.
        }
      }
      if (response === null) {
        invitationReceipts.delete(request.acceptanceReceipt);
        return { kind: "invitation_acceptance_uncertain" };
      }
      if (!response.ok) {
        if (response.code === "step_up_required") {
          invitationReceipts.delete(request.acceptanceReceipt);
          return { kind: "step_up_required" };
        }
        if (response.code === "session_expired") {
          invitationReceipts.delete(request.acceptanceReceipt);
          return { kind: "session_expired" };
        }
        if (response.code === "session_revoked") {
          invitationReceipts.delete(request.acceptanceReceipt);
          return { kind: "session_revoked" };
        }
        if (response.code === "authentication_required") {
          invitationReceipts.delete(request.acceptanceReceipt);
          return { kind: "signed_out" };
        }
        const reason =
          response.code === "invitation_expired"
            ? "expired"
            : response.code === "invitation_not_found"
              ? "replayed"
              : "invalid";
        invitationReceipts.delete(request.acceptanceReceipt);
        return { kind: "invitation_rejected", reason };
      }
      invitationReceipts.delete(request.acceptanceReceipt);
      if (!(await sameRecipient())) {
        return { kind: "invitation_accepted", passwordOutcome: "unknown" };
      }
      const passwordOutcome = await updatePasswordOutcome(
        request.password,
        authorityHandle,
      );
      if (passwordOutcome === "updated") {
        try {
          const access = await readAuthority();
          if (matchesAcceptedInvitation(access, receipt)) return access;
          if (
            access.kind === "session_revoked" ||
            access.kind === "session_expired"
          ) {
            return access;
          }
        } catch {
          // Acceptance and password success remain true even when access cannot
          // be revalidated. A fresh sign-in provides the next authority check.
        }
      }
      if (await sameRecipient()) {
        try {
          await dependencies.port.signOut("local", authorityHandle);
        } catch {
          // The UI requires a new entry flow without claiming sign-out completed.
        }
      }
      clearAuthorityState();
      return { kind: "invitation_accepted", passwordOutcome };
    } finally {
      dependencies.port.releasePasswordAuthority(authorityHandle);
    }
  }

  function matchesAcceptedInvitation(
    result: StaffAuthBoundaryResult,
    receipt: InvitationReceipt,
  ): result is StaffAuthAccessGrant {
    return (
      result.kind === "access_granted" &&
      result.identity.accountId === receipt.accountId &&
      result.identity.email === receipt.email &&
      result.identity.school.id === receipt.schoolId &&
      result.identity.membership.role === receipt.role
    );
  }

  async function updatePasswordOutcome(
    password: string,
    authorityHandle: string,
  ): Promise<"updated" | "rejected" | "unknown"> {
    try {
      return (
        decodeStatus(
          await dependencies.port.updatePassword(password, authorityHandle),
          ["updated", "rejected"],
        ) ?? "unknown"
      );
    } catch {
      return "unknown";
    }
  }

  async function beginTotpEnrollment(
    ceremonyOperationId: string,
  ): Promise<StaffAuthBoundaryResult> {
    const authority = await readAuthority();
    if (authority.kind !== "access_granted") {
      return authority;
    }
    if (
      (authority.identity.membership.role !== "admin" &&
        authority.identity.membership.role !== "owner") ||
      authority.assuranceLevel !== "aal1" ||
      authority.secondFactor !== "enrollment_required"
    ) {
      throw new Error("TOTP enrollment authority is unavailable");
    }
    const enrollment = decodeTotpEnrollment(
      await dependencies.port.enrollTotp(),
    );
    if (enrollment === null) {
      throw new Error("TOTP enrollment result is malformed");
    }
    let presentation: RevocablePresentation | null = null;
    try {
      const blob = decodeTotpQrBlob(enrollment.qrCode);
      if (blob === null) {
        throw new Error("TOTP enrollment presentation is malformed");
      }
      const blobUrl = dependencies.createBlobUrl(blob);
      if (!isBlobUrl(blobUrl)) {
        throw new Error("TOTP enrollment presentation is unavailable");
      }
      presentation = { blobUrl, revoked: false };
      activePresentations.add(presentation);
      const enrollmentReceipt = nextGeneration();
      if (enrollmentReceipts.has(enrollmentReceipt)) {
        throw new Error("TOTP enrollment receipt generation collided");
      }
      enrollmentReceipts.set(enrollmentReceipt, {
        ceremonyOperationId,
        expiresAt: readNow(dependencies.clock) + 5 * 60 * 1000,
        factorId: enrollment.factorId,
        identityGeneration: authority.identityGeneration,
        presentation,
        sessionGeneration: authority.sessionGeneration,
      });
      trimEnrollmentReceipts(enrollmentReceipts, 8, removeEnrollmentReceipt);
      return {
        enrollmentReceipt,
        kind: "totp_enrollment_ready",
        presentation: {
          blobUrl,
          revoke: () => {
            if (presentation !== null) {
              revokePresentation(presentation);
            }
          },
        },
      };
    } catch (error) {
      if (presentation !== null) {
        revokePresentation(presentation);
      }
      void dependencies.port
        .removeTotpFactor(enrollment.factorId)
        .catch(() => undefined);
      throw error;
    }
  }

  async function verifyTotpMutation(
    request: Extract<StaffAuthMutation, { readonly type: "verify_totp" }>,
  ): Promise<StaffAuthBoundaryResult> {
    if (!/^\d{6}$/u.test(request.code)) {
      return { kind: "totp_rejected" };
    }
    const receipt =
      request.purpose === "step_up"
        ? challengeReceipts.get(request.challengeReceipt)
        : enrollmentReceipts.get(request.enrollmentReceipt);
    const validReceipt =
      receipt !== undefined &&
      receipt.expiresAt > readNow(dependencies.clock) &&
      receipt.identityGeneration === identityGeneration &&
      receipt.sessionGeneration === sessionGeneration &&
      (request.purpose === "step_up" ||
        ("ceremonyOperationId" in receipt &&
          receipt.ceremonyOperationId === request.ceremonyOperationId));
    if (!validReceipt || receipt === undefined) {
      if (request.purpose === "enrollment") {
        removeEnrollmentReceipt(request.enrollmentReceipt, true);
      }
      return { kind: "totp_rejected" };
    }
    const challenge = decodeTotpChallenge(
      await dependencies.port.challengeTotp(receipt.factorId),
    );
    if (challenge === null) {
      if (request.purpose === "enrollment") {
        removeEnrollmentReceipt(request.enrollmentReceipt, true);
      }
      throw new Error("TOTP challenge result is malformed");
    }
    const verification = decodeStatus(
      await dependencies.port.verifyTotp({
        challengeId: challenge.challengeId,
        code: request.code,
        factorId: receipt.factorId,
      }),
      ["verified", "rejected"],
    );
    if (verification === null) {
      if (request.purpose === "enrollment") {
        removeEnrollmentReceipt(request.enrollmentReceipt, true);
      }
      throw new Error("TOTP verification result is malformed");
    }
    if (verification === "rejected") {
      if (request.purpose === "enrollment") {
        removeEnrollmentReceipt(request.enrollmentReceipt, true);
      }
      return { kind: "totp_rejected" };
    }
    if (request.purpose === "step_up") {
      challengeReceipts.delete(request.challengeReceipt);
    } else {
      removeEnrollmentReceipt(request.enrollmentReceipt, false);
    }
    const authority = await readAuthority();
    if (
      authority.kind !== "access_granted" ||
      authority.assuranceLevel !== "aal2" ||
      authority.secondFactor !== "satisfied" ||
      authority.identityGeneration !== receipt.identityGeneration ||
      authority.sessionGeneration !== receipt.sessionGeneration
    ) {
      throw new Error("TOTP verification authority continuity failed");
    }
    return authority;
  }

  async function signOut(
    scope: "all" | "local",
  ): Promise<StaffAuthBoundaryResult> {
    // Capture the account established by the visible authority before any await.
    // A missing identity cannot authorize logout of whichever account storage
    // happens to contain when a later SDK operation resumes.
    const initiatingIdentity = identityFacts;
    const expectedAccountId = initiatingIdentity?.accountId;
    const expectedProviderSessionId = providerSessionId;
    if (expectedAccountId === undefined || expectedProviderSessionId === null) {
      throw new Error("Sign-out requires authoritative re-entry");
    }
    const captured = await dependencies.port.captureSignOutAuthority(
      expectedAccountId,
      expectedProviderSessionId,
    );
    if (decodeStatus(captured, ["ended"]) === "ended") {
      clearAuthorityState(false);
      invitationReceipts.clear();
      return { kind: "signed_out" };
    }
    const authority = snapshotExactRecord(captured, [
      "status",
      "authorityHandle",
    ]);
    if (
      authority?.status !== "ready" ||
      !validOpaqueCredential(authority.authorityHandle, 512)
    ) {
      throw new Error("Sign-out authority is unavailable; re-entry required");
    }
    const authorityHandle = authority.authorityHandle;
    try {
      if (
        identityFacts !== initiatingIdentity ||
        providerSessionId !== expectedProviderSessionId
      ) {
        throw new Error("Sign-out was abandoned; re-entry required");
      }
      const revocationRows =
        scope === "all"
          ? await dependencies.port.revokeAllStaffSessions(authorityHandle)
          : await dependencies.port.revokeCurrentStaffSession(authorityHandle);
      const revocationCode = decodeRpcCode(revocationRows);
      if (revocationCode !== "ok" && revocationCode !== "session_revoked") {
        const loss = boundaryFailure(revocationCode);
        if (loss !== null) return loss;
        throw new Error("Application session revocation is unavailable");
      }
      const providerResult = decodeStatus(
        await dependencies.port.signOut(scope, authorityHandle),
        ["signed_out"],
      );
      if (providerResult !== "signed_out") {
        throw new Error("Provider sign-out is unavailable");
      }
      clearAuthorityState(false);
      invitationReceipts.clear();
      pendingVerificationEmail = null;
      return { kind: "sign_out_complete", scope };
    } finally {
      dependencies.port.releasePasswordAuthority(authorityHandle);
    }
  }

  async function resetToSignIn(): Promise<StaffAuthBoundaryResult> {
    // Navigation abandons this application's ceremonies. Provider sessions and
    // factors are untouched, including an account installed by another tab.
    dependencies.port.clearPrivateAuthContinuations();
    clearAuthorityState(false);
    invitationReceipts.clear();
    pendingVerificationEmail = null;
    recoveryContinuation = null;
    return { kind: "reset_to_sign_in_complete" };
  }

  type ManagementRequest = Extract<
    StaffAuthMutation,
    {
      readonly type:
        | "create_staff_invitation"
        | "revoke_staff_invitation"
        | "revoke_staff_membership"
        | "change_staff_membership_role";
    }
  >;
  interface ManagementIntent {
    readonly accountId: string;
    readonly providerSessionId: string;
    readonly identityGeneration: string;
    readonly sessionGeneration: string;
    readonly revision: number;
  }

  function captureManagementIntent(
    request: ManagementRequest,
  ): ManagementIntent {
    // Snapshot the visible initiating account before any asynchronous SDK read.
    // Never infer the initiator from whichever account later occupies storage.
    if (
      identityFacts === null ||
      identityGeneration === null ||
      sessionGeneration === null ||
      providerSessionId === null ||
      identityGeneration !== request.expectedIdentityGeneration ||
      sessionGeneration !== request.expectedSessionGeneration ||
      eventRevision !== processedEventRevision
    ) {
      throw new Error("Staff management actor continuity failed");
    }
    return {
      accountId: identityFacts.accountId,
      providerSessionId,
      identityGeneration,
      sessionGeneration,
      revision: eventRevision,
    };
  }

  function managementIntentCurrent(intent: ManagementIntent): boolean {
    return (
      !disposed &&
      eventRevision === intent.revision &&
      identityGeneration === intent.identityGeneration &&
      sessionGeneration === intent.sessionGeneration &&
      providerSessionId === intent.providerSessionId &&
      identityFacts?.accountId === intent.accountId
    );
  }

  async function withManagementAuthority(
    request: ManagementRequest,
    action: (
      actor: StaffAuthAccessGrant,
      authorityHandle: string,
      intent: ManagementIntent,
    ) => Promise<StaffAuthBoundaryResult>,
  ): Promise<StaffAuthBoundaryResult> {
    const intent = captureManagementIntent(request);
    const captured = await dependencies.port.captureStaffManagementAuthority(
      intent.accountId,
      intent.providerSessionId,
    );
    const ready = snapshotExactRecord(captured, ["status", "authorityHandle"]);
    if (ready?.status !== "ready" || !validText(ready.authorityHandle, 256)) {
      if (decodeStatus(captured, ["ended"]) === "ended")
        return { kind: "signed_out" };
      throw new Error("Staff management authority is unavailable");
    }
    const authorityHandle = ready.authorityHandle;
    try {
      if (!managementIntentCurrent(intent))
        throw new Error("Staff management actor continuity failed");
      const actor = await readAuthority();
      if (eventRevision !== intent.revision)
        throw new Error("Staff management actor continuity failed");
      if (actor.kind !== "access_granted") return actor;
      if (actor.identity.accountId !== intent.accountId)
        throw new Error("Staff management actor continuity failed");
      // A real same-account downgrade remains a valid current role. It cannot
      // inherit a command prepared under the prior management authority.
      if (
        !managementIntentCurrent(intent) ||
        actor.identity.school.id !== request.schoolId ||
        (actor.identity.membership.role !== "owner" &&
          actor.identity.membership.role !== "admin")
      )
        return actor;
      if (actor.assuranceLevel !== "aal2" || actor.secondFactor !== "satisfied")
        return { kind: "step_up_required" };
      return await action(actor, authorityHandle, intent);
    } finally {
      dependencies.port.releaseStaffManagementAuthority(authorityHandle);
    }
  }

  function requireManagementContinuity(intent: ManagementIntent): void {
    if (!managementIntentCurrent(intent))
      throw new Error("Staff management actor continuity failed");
  }

  async function refreshManagementActor(
    expected: StaffAuthAccessGrant,
    intent: ManagementIntent,
  ): Promise<StaffAuthBoundaryResult> {
    requireManagementContinuity(intent);
    const authority = await readAuthority();
    if (disposed || eventRevision !== intent.revision)
      throw new Error("Staff management actor continuity failed");
    if (authority.kind !== "access_granted") return authority;
    if (authority.identity.accountId !== intent.accountId)
      throw new Error("Staff management actor continuity failed");
    if (
      authority.identity.school.id !== expected.identity.school.id ||
      authority.identity.membership.role !== expected.identity.membership.role
    )
      return authority;
    if (!sameAccessAuthority(authority, expected))
      throw new Error("Staff management actor continuity failed");
    return authority;
  }

  function actorRetainsManagement(
    authority: StaffAuthAccessGrant,
    expected: StaffAuthAccessGrant,
  ): boolean {
    return (
      authority.identity.school.id === expected.identity.school.id &&
      authority.identity.membership.role ===
        expected.identity.membership.role &&
      authority.assuranceLevel === "aal2" &&
      authority.secondFactor === "satisfied"
    );
  }

  async function createStaffInvitation(
    request: Extract<
      StaffAuthMutation,
      { readonly type: "create_staff_invitation" }
    >,
  ): Promise<StaffAuthBoundaryResult> {
    return withManagementAuthority(
      request,
      async (actor, authorityHandle, intent) => {
        const input = parseCreateStaffInvitationRequest({
          email: request.email,
          role:
            request.targetRole === "admin"
              ? "administrator"
              : request.targetRole,
          schoolId: request.schoolId,
        });
        if (
          input === null ||
          (actor.identity.membership.role === "admin" &&
            request.targetRole !== "teacher")
        )
          return { actor, kind: "staff_invitation_rejected" };
        requireManagementContinuity(intent);
        const response = parseCreateStaffInvitationResponse(
          await dependencies.port.invokeInvitation(input, authorityHandle),
        );
        if (response === null)
          throw new Error("Staff invitation result is malformed");
        const refreshed = await refreshManagementActor(actor, intent);
        if (
          refreshed.kind !== "access_granted" ||
          !actorRetainsManagement(refreshed, actor)
        )
          return refreshed;
        if (!response.ok) {
          if (
            response.code === "invitation_delivery_unconfirmed" ||
            response.code === "invitation_delivery_rejected"
          ) {
            return {
              actor: refreshed,
              kind: "staff_invitation_delivery",
              outcome:
                response.code === "invitation_delivery_unconfirmed"
                  ? "unconfirmed"
                  : "rejected",
            };
          }
          const loss = boundaryFailure(response.code);
          return (
            loss ?? { actor: refreshed, kind: "staff_invitation_rejected" }
          );
        }
        return {
          actor: refreshed,
          invitedRole: request.targetRole,
          kind: "staff_invitation_created",
        };
      },
    );
  }

  async function revokeStaffInvitation(
    request: Extract<
      StaffAuthMutation,
      { readonly type: "revoke_staff_invitation" }
    >,
  ): Promise<StaffAuthBoundaryResult> {
    return withManagementAuthority(
      request,
      async (actor, authorityHandle, intent) => {
        const target = actor.manageableInvitations.find(
          (entry) =>
            entry.invitationId === request.invitationId &&
            entry.schoolId === request.schoolId,
        );
        const input = parseRevokeStaffInvitationRequest({
          invitationId: request.invitationId,
        });
        if (
          input === null ||
          target === undefined ||
          (actor.identity.membership.role === "admin" &&
            target.role !== "teacher")
        )
          return { actor, kind: "staff_invitation_revocation_rejected" };
        requireManagementContinuity(intent);
        const response = parseRevokeStaffInvitationResponse(
          productRpcResponse(
            exactSingleRow(
              await dependencies.port.revokeInvitation(input, authorityHandle),
            ),
            "invitation_revoked",
          ),
        );
        if (response === null)
          throw new Error("Staff invitation revocation result is malformed");
        const refreshed = await refreshManagementActor(actor, intent);
        if (
          refreshed.kind !== "access_granted" ||
          !actorRetainsManagement(refreshed, actor)
        )
          return refreshed;
        if (!response.ok)
          return (
            boundaryFailure(response.code) ?? {
              actor: refreshed,
              kind: "staff_invitation_revocation_rejected",
            }
          );
        return {
          actor: refreshed,
          invitationId: request.invitationId,
          kind: "staff_invitation_revoked",
          revokedRole: target.role,
          schoolId: request.schoolId,
        };
      },
    );
  }

  async function revokeStaffMembership(
    request: Extract<
      StaffAuthMutation,
      { readonly type: "revoke_staff_membership" }
    >,
  ): Promise<StaffAuthBoundaryResult> {
    return withManagementAuthority(
      request,
      async (actor, authorityHandle, intent) => {
        const target = actor.manageableStaff.find(
          (entry) =>
            entry.profile.id === request.profileId &&
            entry.schoolId === request.schoolId,
        );
        const input = parseRevokeStaffMembershipRequest({
          profileId: request.profileId,
          schoolId: request.schoolId,
          expectedRoleRevision: request.expectedRoleRevision,
        });
        if (
          input === null ||
          target === undefined ||
          target.profile.id === actor.identity.profile.id ||
          (actor.identity.membership.role === "admin" &&
            target.role !== "teacher")
        )
          return { actor, kind: "staff_membership_revocation_rejected" };
        if (target.roleRevision !== request.expectedRoleRevision)
          return { actor, kind: "staff_membership_revision_conflict" };
        requireManagementContinuity(intent);
        const response = parseRevokeStaffMembershipResponse(
          productRpcResponse(
            exactSingleRow(
              await dependencies.port.revokeMembership(input, authorityHandle),
            ),
            "membership_revoked",
          ),
        );
        if (response === null)
          throw new Error("Staff membership revocation result is malformed");
        const refreshed = await refreshManagementActor(actor, intent);
        if (
          refreshed.kind !== "access_granted" ||
          !actorRetainsManagement(refreshed, actor)
        )
          return refreshed;
        if (!response.ok) {
          if (response.code === "membership_revision_conflict")
            return {
              actor: refreshed,
              kind: "staff_membership_revision_conflict",
            };
          if (response.code === "authorization_denied")
            return {
              actor: refreshed,
              kind: "staff_membership_revocation_rejected",
            };
          return (
            boundaryFailure(response.code) ?? {
              actor: refreshed,
              kind: "staff_membership_revocation_rejected",
            }
          );
        }
        return {
          actor: refreshed,
          kind: "staff_membership_revoked",
          profileId: request.profileId,
          revokedRole: target.role,
          schoolId: request.schoolId,
        };
      },
    );
  }

  async function changeStaffMembershipRole(
    request: Extract<
      StaffAuthMutation,
      { readonly type: "change_staff_membership_role" }
    >,
  ): Promise<StaffAuthBoundaryResult> {
    return withManagementAuthority(
      request,
      async (actor, authorityHandle, intent) => {
        const target = actor.manageableStaff.find(
          (entry) =>
            entry.profile.id === request.profileId &&
            entry.schoolId === request.schoolId,
        );
        const input = parseChangeStaffMembershipRoleRequest({
          profileId: request.profileId,
          schoolId: request.schoolId,
          expectedRoleRevision: request.expectedRoleRevision,
          role:
            request.targetRole === "admin"
              ? "administrator"
              : request.targetRole,
        });
        if (
          actor.identity.membership.role !== "owner" ||
          input === null ||
          target === undefined ||
          target.profile.id === actor.identity.profile.id
        )
          return { actor, kind: "staff_membership_role_change_rejected" };
        if (target.roleRevision !== request.expectedRoleRevision)
          return { actor, kind: "staff_membership_revision_conflict" };
        if (target.role === request.targetRole)
          return { actor, kind: "staff_membership_role_change_rejected" };
        requireManagementContinuity(intent);
        let response;
        try {
          response = parseChangeStaffMembershipRoleResponse(
            productRpcResponse(
              exactSingleRow(
                await dependencies.port.changeMembershipRole(
                  input,
                  authorityHandle,
                ),
              ),
              "membership_role_changed",
            ),
          );
        } catch {
          return { kind: "staff_membership_role_change_unconfirmed" };
        }
        // An unknown mutation response cannot be resolved by inspecting whether
        // a later list happens to contain the requested role. Never replay it.
        if (
          response === null ||
          (!response.ok && response.code === "service_unavailable") ||
          !managementIntentCurrent(intent)
        )
          return { kind: "staff_membership_role_change_unconfirmed" };
        const refreshed = await refreshManagementActor(actor, intent);
        if (
          refreshed.kind !== "access_granted" ||
          !actorRetainsManagement(refreshed, actor)
        )
          return refreshed;
        if (!response.ok) {
          if (response.code === "membership_revision_conflict")
            return {
              actor: refreshed,
              kind: "staff_membership_revision_conflict",
            };
          if (response.code === "authorization_denied")
            return {
              actor: refreshed,
              kind: "staff_membership_role_change_rejected",
            };
          return (
            boundaryFailure(response.code) ?? {
              actor: refreshed,
              kind: "staff_membership_role_change_rejected",
            }
          );
        }
        return {
          actor: refreshed,
          changedRole: request.targetRole,
          kind: "staff_membership_role_changed",
          profileId: request.profileId,
          schoolId: request.schoolId,
        };
      },
    );
  }

  async function completePasswordRecovery(
    operationId: string,
    password: string,
  ): Promise<StaffAuthBoundaryResult> {
    if (!isPassword(password)) {
      return { kind: "password_recovery_rejected" };
    }
    const initiatingRevision = eventRevision;
    const authorityHandle = await dependencies.port.capturePasswordAuthority();
    if (authorityHandle === null) return { kind: "password_recovery_rejected" };
    try {
      if (eventRevision !== initiatingRevision) {
        return {
          kind: "password_recovery_uncertain",
          passwordOutcome: "unknown",
          cleanupComplete: false,
        };
      }
      const begin = parseBeginStaffPasswordRecoveryRpcResult(
        exactSingleRow(
          await dependencies.port.beginPasswordRecovery(
            operationId,
            authorityHandle,
          ),
        ),
      );
      if (begin === null) {
        throw new Error("Password recovery begin result is malformed");
      }
      if (!begin.ok) {
        return passwordRecoveryFailure(begin);
      }
      if (eventRevision !== initiatingRevision) {
        return {
          kind: "password_recovery_uncertain",
          passwordOutcome: "unknown",
          cleanupComplete: false,
        };
      }
      // begin returns the canonical nonsecret operation for this recovery session.
      // A previous cleanup result cannot establish what happened at the provider.
      const passwordOutcome =
        begin.code === "recovery_sessions_revoked"
          ? await updatePasswordOutcome(password, authorityHandle)
          : "unknown";
      if (eventRevision !== initiatingRevision) {
        return {
          kind: "password_recovery_uncertain",
          passwordOutcome,
          cleanupComplete: false,
        };
      }
      let cleanupComplete = false;
      try {
        const finish = parseFinishStaffPasswordRecoveryRpcResult(
          exactSingleRow(
            await dependencies.port.finishPasswordRecovery(
              begin.operationId,
              authorityHandle,
            ),
          ),
        );
        cleanupComplete = finish?.ok === true;
      } catch {
        cleanupComplete = false;
      }
      if (eventRevision !== initiatingRevision) {
        return {
          kind: "password_recovery_uncertain",
          passwordOutcome,
          cleanupComplete: false,
        };
      }
      try {
        const signOut = decodeStatus(
          await dependencies.port.signOut("all", authorityHandle),
          ["signed_out"],
        );
        cleanupComplete = cleanupComplete && signOut === "signed_out";
      } catch {
        cleanupComplete = false;
      }
      clearAuthorityState();
      invitationReceipts.clear();
      if (cleanupComplete && passwordOutcome === "updated") {
        return { kind: "password_recovery_complete", sessionScope: "all" };
      }
      if (cleanupComplete && passwordOutcome === "rejected") {
        return { kind: "password_recovery_rejected" };
      }
      return {
        kind: "password_recovery_uncertain",
        passwordOutcome,
        cleanupComplete,
      };
    } finally {
      dependencies.port.releasePasswordAuthority(authorityHandle);
    }
  }

  function emitEvent(event: StaffAuthAccessEvent): void {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Consumer failures are outside the authorization boundary.
      }
    }
  }

  function waitForMutations(): Promise<void> {
    if (activeMutations === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      mutationWaiters.add(resolve);
    });
  }

  function notifyMutationWaiters(): void {
    if (activeMutations !== 0) {
      return;
    }
    for (const resolve of mutationWaiters) {
      resolve();
    }
    mutationWaiters.clear();
  }

  async function readLatestAuthority(): Promise<StaffAuthBoundaryResult> {
    let result: StaffAuthBoundaryResult;
    do {
      await waitForMutations();
      if (disposed) {
        throw new Error("Staff authentication adapter is disposed");
      }
      const targetRevision = eventRevision;
      result = await readAuthority({
        rotateSession: targetRevision > processedEventRevision,
      });
      processedEventRevision = Math.max(processedEventRevision, targetRevision);
    } while (!disposed && eventRevision > processedEventRevision);
    if (disposed) {
      throw new Error("Staff authentication adapter is disposed");
    }
    return result;
  }

  const unsubscribeProvider = dependencies.port.onAuthStateChange(() => {
    if (disposed) {
      return;
    }
    invitationInspectionContinuations.clear();
    invitationReceipts.clear();
    pendingVerificationEmail = null;
    clearAuthorityState(false);
    eventRevision += 1;
    emitEvent({ kind: "revalidation_required" });
  });

  return {
    async read() {
      if (disposed) {
        throw new Error("Staff authentication adapter is disposed");
      }
      if (authorityRead === null) {
        authorityRead = readLatestAuthority().finally(() => {
          authorityRead = null;
        });
      }
      return authorityRead;
    },
    async perform(
      request: StaffAuthMutation,
    ): Promise<StaffAuthMutationResult> {
      if (disposed) {
        throw new Error("Staff authentication adapter is disposed");
      }
      if (!isCanonicalUuid(request.operationId)) {
        throw new Error("Staff authentication operation is invalid");
      }
      const requestIdentity = operationRequestIdentity(request);
      const completed = completedOperations.get(request.operationId);
      if (completed !== undefined) {
        if (
          completed.type !== request.type ||
          completed.requestIdentity !== requestIdentity
        ) {
          throw new Error("Staff authentication operation was reused");
        }
        if (completed.result === null) {
          throw new Error("Staff authentication operation requires re-entry");
        }
        return { operationId: request.operationId, result: completed.result };
      }
      const inFlight = inFlightOperations.get(request.operationId);
      if (inFlight !== undefined) {
        if (
          inFlight.type !== request.type ||
          inFlight.requestIdentity !== requestIdentity ||
          requestIdentity === null
        ) {
          throw new Error("Staff authentication operation was reused");
        }
        return inFlight.promise;
      }
      activeMutations += 1;
      const operationId = request.operationId;
      const operationType = request.type;
      const promise = performMutation(request)
        .then((result) => {
          if (disposed) {
            throw new Error("Staff authentication adapter is disposed");
          }
          completedOperations.set(operationId, {
            requestIdentity,
            result:
              requestIdentity === null ||
              isManagementMutation(operationType) ||
              requiresCredentialReentry(result.result)
                ? null
                : result.result,
            type: operationType,
          });
          trimMap(completedOperations, 64);
          return result;
        })
        .catch((error: unknown) => {
          if (
            operationType === "sign_out" ||
            isManagementMutation(operationType)
          ) {
            // An uncertain attempt cannot recapture a new account/session when
            // the controller replays this operation ID. Re-enter first.
            completedOperations.set(operationId, {
              requestIdentity,
              result: null,
              type: operationType,
            });
            trimMap(completedOperations, 64);
            if (operationType === "sign_out") clearAuthorityState(false);
          }
          throw error;
        })
        .finally(() => {
          inFlightOperations.delete(operationId);
          activeMutations -= 1;
          notifyMutationWaiters();
        });
      inFlightOperations.set(operationId, {
        promise,
        requestIdentity,
        type: operationType,
      });
      return promise;
    },
    subscribe(listener) {
      if (disposed) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      recoveryContinuation = null;
      eventRevision += 1;
      try {
        unsubscribeProvider();
      } catch {
        // Provider unsubscription is best-effort after fail-closed disposal.
      }
      listeners.clear();
      completedOperations.clear();
      inFlightOperations.clear();
      for (const resolve of mutationWaiters) {
        resolve();
      }
      mutationWaiters.clear();
      challengeReceipts.clear();
      clearEnrollmentReceipts(true);
      invitationReceipts.clear();
      invitationInspectionContinuations.clear();
      pendingVerificationEmail = null;
      for (const presentation of [...activePresentations]) {
        revokePresentation(presentation);
      }
      clearAuthorityState();
    },
  };
}

interface ChallengeReceipt {
  readonly expiresAt: number;
  readonly factorId: string;
  readonly identityGeneration: string;
  readonly sessionGeneration: string;
}

interface RevocablePresentation {
  readonly blobUrl: string;
  revoked: boolean;
}

interface EnrollmentReceipt extends ChallengeReceipt {
  readonly ceremonyOperationId: string;
  readonly presentation: RevocablePresentation;
}

interface CompletedOperation {
  readonly requestIdentity: string | null;
  readonly result: StaffAuthBoundaryResult | null;
  readonly type: StaffAuthMutation["type"];
}

interface InvitationReceipt {
  readonly accountId: string;
  readonly email: string;
  readonly expiresAt: number;
  readonly inspectionOperationId: string;
  readonly invitationId: string;
  readonly role: "admin" | "teacher";
  readonly schoolId: string;
  readonly schoolLabel: string;
}

interface InvitationInspectionContinuation {
  readonly accountId: string;
  readonly continuationReceipt: string;
  readonly expiresAt: number;
  readonly identityGeneration: string;
  readonly inspectionOperationId: string;
  readonly sessionGeneration: string;
}

type CurrentInvitationResult =
  | {
      readonly expiresAt: string;
      readonly expiresAtMilliseconds: number;
      readonly invitationId: string;
      readonly kind: "ready";
      readonly role: "admin" | "teacher";
      readonly schoolId: string;
      readonly schoolLabel: string;
    }
  | {
      readonly kind: "rejected";
      readonly reason: "expired" | "invalid" | "replayed";
    };

interface TotpFactor {
  readonly factorId: string;
  readonly friendlyName: string | null;
  readonly status: "unverified" | "verified";
}

function passwordRecoveryFailure(
  failure:
    | Exclude<BeginStaffPasswordRecoveryRpcResult, { readonly ok: true }>
    | Exclude<FinishStaffPasswordRecoveryRpcResult, { readonly ok: true }>,
): StaffAuthBoundaryResult {
  if (failure.code === "session_expired") {
    return { kind: "session_expired" };
  }
  if (failure.code === "unauthenticated") {
    return { kind: "signed_out" };
  }
  return { kind: "password_recovery_rejected" };
}

function decodeInvitationVerification(value: unknown):
  | {
      readonly accountId: string;
      readonly email: string;
      readonly status: "verified";
    }
  | { readonly status: "expired" | "invalid" | "replayed" }
  | null {
  const statusOnly = snapshotExactRecord(value, ["status"]);
  if (
    statusOnly !== null &&
    (statusOnly.status === "expired" ||
      statusOnly.status === "invalid" ||
      statusOnly.status === "replayed")
  ) {
    return { status: statusOnly.status };
  }
  const verified = snapshotExactRecord(value, ["accountId", "email", "status"]);
  return verified !== null &&
    verified.status === "verified" &&
    isCanonicalUuid(verified.accountId) &&
    isCanonicalEmail(verified.email)
    ? {
        accountId: verified.accountId,
        email: verified.email,
        status: "verified",
      }
    : null;
}

function decodeCurrentInvitation(value: unknown): CurrentInvitationResult {
  const rows = snapshotArray(value, 2);
  if (rows === null || rows.length !== 1) {
    throw new Error("Current invitation result is ambiguous");
  }
  const row = snapshotExactRecord(rows[0], [
    "code",
    "expires_at",
    "invitation_id",
    "invited_role",
    "school_id",
    "school_name",
  ]);
  if (row === null || typeof row.code !== "string") {
    throw new Error("Current invitation result is malformed");
  }
  if (row.code !== "ok") {
    if (
      row.expires_at !== null ||
      row.invitation_id !== null ||
      row.invited_role !== null ||
      row.school_id !== null ||
      row.school_name !== null
    ) {
      throw new Error("Current invitation failure is malformed");
    }
    return {
      kind: "rejected",
      reason:
        row.code === "invitation_expired"
          ? "expired"
          : row.code === "invitation_consumed"
            ? "replayed"
            : "invalid",
    };
  }
  const expiresAt = parseRpcTimestamp(row.expires_at);
  if (
    expiresAt === null ||
    !isCanonicalUuid(row.invitation_id) ||
    !isCanonicalUuid(row.school_id) ||
    !validText(row.school_name, 200) ||
    (row.invited_role !== "admin" && row.invited_role !== "teacher")
  ) {
    throw new Error("Current invitation result is malformed");
  }
  return {
    expiresAt,
    expiresAtMilliseconds: Date.parse(expiresAt),
    invitationId: row.invitation_id,
    kind: "ready",
    role: row.invited_role,
    schoolId: row.school_id,
    schoolLabel: row.school_name,
  };
}

function productRpcResponse(value: unknown, successCode: string): unknown {
  const row = snapshotExactRecord(value, ["code"]);
  if (row === null || typeof row.code !== "string") {
    return null;
  }
  if (row.code === successCode) {
    return { code: successCode, ok: true };
  }
  const code = staffAuthRpcFailureCodes.find(
    (candidate) => candidate === row.code,
  );
  return code === undefined
    ? null
    : mapStaffAuthInternalFailure({ code, source: "rpc" });
}

function parseRpcTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const canonical = date.toISOString();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(canonical)
    ? canonical
    : null;
}

interface IdentityFacts {
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string;
  readonly profileId: string;
  readonly role: "admin" | "owner" | "teacher";
  readonly roleRevision: number;
  readonly schoolId: string;
}

function mapManagedStaff(
  staff: ManageableStaffMember,
): StaffAuthBoundaryManagedStaff {
  return {
    profile: {
      displayName: staff.displayName,
      email: staff.email,
      id: staff.profileId,
    },
    role: staff.role === "administrator" ? "admin" : "teacher",
    roleRevision: staff.roleRevision,
    schoolId: staff.schoolId,
  };
}

function mapManagedInvitation(
  invitation: ManageableStaffInvitation,
): StaffAuthBoundaryManagedInvitation {
  return {
    email: invitation.email,
    expiresAt: invitation.expiresAt,
    invitationId: invitation.invitationId,
    role: invitation.role === "administrator" ? "admin" : "teacher",
    schoolId: invitation.schoolId,
    state: invitation.state,
  };
}

function managementFailure(
  code:
    | "authentication_required"
    | "authorization_denied"
    | "service_unavailable"
    | "session_expired"
    | "session_revoked"
    | "step_up_required",
): StaffAuthBoundaryResult {
  switch (code) {
    case "authentication_required":
      return { kind: "signed_out" };
    case "authorization_denied":
      return { kind: "membership_inactive" };
    case "session_expired":
      return { kind: "session_expired" };
    case "session_revoked":
      return { kind: "session_revoked" };
    case "step_up_required":
      return { kind: "step_up_required" };
    case "service_unavailable":
      throw new Error("Staff management dependency is unavailable");
  }
}

function boundaryFailure(code: unknown): StaffAuthBoundaryResult | null {
  switch (code) {
    case "authentication_required":
    case "unauthenticated":
      return { kind: "signed_out" };
    case "authorization_denied":
    case "membership_inactive":
      return { kind: "membership_inactive" };
    case "email_unverified":
      return { kind: "email_verification_required" };
    case "session_expired":
      return { kind: "session_expired" };
    case "session_revoked":
      return { kind: "session_revoked" };
    case "step_up_required":
      return { kind: "step_up_required" };
    case "dependency_unavailable":
    case "service_unavailable":
      throw new Error("Staff authentication dependency is unavailable");
    default:
      return null;
  }
}

function sameAccessAuthority(
  left: StaffAuthAccessGrant,
  right: StaffAuthAccessGrant,
): boolean {
  return (
    left.identityGeneration === right.identityGeneration &&
    left.sessionGeneration === right.sessionGeneration &&
    left.providerSessionId === right.providerSessionId &&
    left.identity.accountId === right.identity.accountId &&
    left.identity.email === right.identity.email &&
    left.identity.membership.id === right.identity.membership.id &&
    left.identity.membership.role === right.identity.membership.role &&
    left.identity.membership.status === right.identity.membership.status &&
    left.identity.profile.displayName === right.identity.profile.displayName &&
    left.identity.profile.id === right.identity.profile.id &&
    left.identity.school.id === right.identity.school.id
  );
}

/**
 * Returns a non-secret canonical identity only for commands that are safe to
 * coalesce or replay. Credential/PII-bearing commands deliberately return
 * null: a reused operation ID then requires fresh user input and the adapter
 * never retains either plaintext credentials or a credential-derived tag.
 */
function operationRequestIdentity(request: StaffAuthMutation): string | null {
  switch (request.type) {
    case "resend_email_verification":
    case "begin_totp_enrollment":
    case "reset_to_sign_in":
      return JSON.stringify([request.type]);
    case "resume_invitation_inspection":
      return JSON.stringify([
        request.type,
        request.continuationReceipt,
        request.inspectionOperationId,
      ]);
    case "sign_out":
      return JSON.stringify([request.type, request.scope]);
    case "revoke_staff_invitation":
      return JSON.stringify([
        request.type,
        request.schoolId,
        request.invitationId,
        request.expectedIdentityGeneration,
        request.expectedSessionGeneration,
      ]);
    case "revoke_staff_membership":
      return JSON.stringify([
        request.type,
        request.schoolId,
        request.profileId,
        request.expectedIdentityGeneration,
        request.expectedSessionGeneration,
        request.expectedRoleRevision,
      ]);
    case "change_staff_membership_role":
      return JSON.stringify([
        request.type,
        request.schoolId,
        request.profileId,
        request.targetRole,
        request.expectedIdentityGeneration,
        request.expectedSessionGeneration,
        request.expectedRoleRevision,
      ]);
    case "sign_in":
    case "exchange_email_verification_code":
    case "verify_totp":
    case "request_password_recovery":
    case "inspect_invitation":
    case "accept_invitation":
    case "exchange_recovery_code":
    case "complete_password_recovery":
    case "create_staff_invitation":
      return null;
  }
}

function isManagementMutation(type: StaffAuthMutation["type"]): boolean {
  return (
    type === "create_staff_invitation" ||
    type === "revoke_staff_invitation" ||
    type === "revoke_staff_membership" ||
    type === "change_staff_membership_role"
  );
}

function requiresCredentialReentry(result: StaffAuthBoundaryResult): boolean {
  return (
    result.kind === "access_granted" ||
    result.kind === "invitation_inspection_interrupted" ||
    result.kind === "invitation_ready" ||
    result.kind === "totp_enrollment_ready" ||
    result.kind === "staff_invitation_created" ||
    result.kind === "staff_invitation_delivery" ||
    result.kind === "staff_invitation_rejected" ||
    result.kind === "staff_invitation_revoked" ||
    result.kind === "staff_invitation_revocation_rejected" ||
    result.kind === "staff_membership_revoked" ||
    result.kind === "staff_membership_revocation_rejected"
  );
}

function decodeRpcCode(value: unknown): string | null {
  const row = snapshotExactRecord(exactSingleRow(value), ["code"]);
  return row !== null && typeof row.code === "string" ? row.code : null;
}

function decodeTotpEnrollment(value: unknown): {
  readonly factorId: string;
  readonly qrCode: string;
} | null {
  const result = snapshotExactRecord(value, ["factorId", "qrCode", "status"]);
  return result !== null &&
    result.status === "enrolled" &&
    isCanonicalUuid(result.factorId) &&
    typeof result.qrCode === "string"
    ? { factorId: result.factorId, qrCode: result.qrCode }
    : null;
}

function decodeTotpChallenge(value: unknown): {
  readonly challengeId: string;
} | null {
  const result = snapshotExactRecord(value, ["challengeId", "status"]);
  return result !== null &&
    result.status === "challenged" &&
    isCanonicalUuid(result.challengeId)
    ? { challengeId: result.challengeId }
    : null;
}

function decodeTotpQrBlob(value: string): Blob | null {
  const prefix = "data:image/svg+xml;utf-8,";
  if (!value.startsWith(prefix) || value.length > 262_144) {
    return null;
  }
  let svg: string;
  try {
    svg = decodeURIComponent(value.slice(prefix.length));
  } catch {
    return null;
  }
  const bytes = new TextEncoder().encode(svg);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > 131_072 ||
    !/^\s*<svg(?:\s|>)/u.test(svg) ||
    !/<\/svg>\s*$/u.test(svg) ||
    /(?:<!doctype|<!entity|<script|<foreignObject|<image|<use|\bhref\s*=|\bon[a-z]+\s*=|\burl\s*\(|javascript:|otpauth:)/iu.test(
      svg,
    )
  ) {
    return null;
  }
  return new Blob([bytes], { type: "image/svg+xml;charset=utf-8" });
}

function isBlobUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("blob:") &&
    value.length <= 4096 &&
    !hasControlText(value)
  );
}

function trimEnrollmentReceipts(
  receipts: Map<string, EnrollmentReceipt>,
  maximumSize: number,
  remove: (receiptId: string, removeFactor: boolean) => void,
): void {
  while (receipts.size > maximumSize) {
    const oldest = receipts.keys().next().value as string | undefined;
    if (oldest === undefined) {
      return;
    }
    remove(oldest, true);
  }
}

type CurrentContextResult =
  | {
      readonly displayName: string;
      readonly kind: "active";
      readonly profileId: string;
      readonly role: "admin" | "owner" | "teacher";
      readonly roleRevision: number;
      readonly schoolId: string;
      readonly schoolLabel: string;
      readonly schoolSettingsRevision: number;
    }
  | {
      readonly kind:
        | "email_verification_required"
        | "membership_inactive"
        | "session_expired"
        | "session_revoked"
        | "signed_out";
    };

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const canonicalEmailPattern =
  /^[a-z0-9!#$%&'*+/=?^_{}|~-]+(?:\.[a-z0-9!#$%&'*+/=?^_{}|~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const canonicalSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function decodeAccount(value: unknown): {
  readonly accountId: string;
  readonly providerSessionId: string;
  readonly email: string;
  readonly emailVerified: boolean;
} | null {
  const account = snapshotExactRecord(value, [
    "accountId",
    "providerSessionId",
    "email",
    "emailVerified",
  ]);
  return account !== null &&
    isCanonicalUuid(account.accountId) &&
    isCanonicalUuid(account.providerSessionId) &&
    isCanonicalEmail(account.email) &&
    typeof account.emailVerified === "boolean"
    ? {
        accountId: account.accountId,
        providerSessionId: account.providerSessionId,
        email: account.email,
        emailVerified: account.emailVerified,
      }
    : null;
}

function decodeAssurance(value: unknown): {
  readonly currentAuthenticationMethods: readonly string[];
  readonly currentLevel: "aal1" | "aal2";
  readonly nextLevel: "aal1" | "aal2";
} | null {
  const assurance = snapshotExactRecord(value, [
    "currentAuthenticationMethods",
    "currentLevel",
    "nextLevel",
  ]);
  const methods =
    assurance === null
      ? null
      : snapshotArray(assurance.currentAuthenticationMethods, 32);
  if (
    assurance === null ||
    methods === null ||
    methods.some(
      (method) =>
        !validText(method, 128) ||
        (typeof method === "string" && method !== method.trim()),
    ) ||
    (assurance.currentLevel !== "aal1" && assurance.currentLevel !== "aal2") ||
    (assurance.nextLevel !== "aal1" && assurance.nextLevel !== "aal2") ||
    (assurance.currentLevel === "aal2" && assurance.nextLevel !== "aal2")
  ) {
    return null;
  }
  return {
    currentAuthenticationMethods: methods as readonly string[],
    currentLevel: assurance.currentLevel,
    nextLevel: assurance.nextLevel,
  };
}

function decodeTotpFactors(value: unknown): TotpFactor[] | null {
  const result = snapshotExactRecord(value, ["factors"]);
  const rows = result === null ? null : snapshotArray(result.factors, 16);
  if (rows === null) {
    return null;
  }
  const factors: TotpFactor[] = [];
  const ids = new Set<string>();
  for (const valueRow of rows) {
    const rowWithoutName = snapshotExactRecord(valueRow, [
      "factorId",
      "status",
    ]);
    const rowWithName = snapshotExactRecord(valueRow, [
      "factorId",
      "friendlyName",
      "status",
    ]);
    const row = rowWithName ?? rowWithoutName;
    const friendlyName =
      rowWithName === null
        ? null
        : sanitizeFactorFriendlyName(rowWithName.friendlyName);
    if (
      row === null ||
      !isCanonicalUuid(row.factorId) ||
      (row.status !== "unverified" && row.status !== "verified") ||
      (rowWithName !== null &&
        rowWithName.friendlyName !== null &&
        typeof rowWithName.friendlyName !== "string") ||
      ids.has(row.factorId)
    ) {
      return null;
    }
    ids.add(row.factorId);
    factors.push({ factorId: row.factorId, friendlyName, status: row.status });
  }
  return factors;
}

function sanitizeFactorFriendlyName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .split("")
    .map((character) =>
      unsafeFactorLabelCharacter(character) ? " " : character,
    )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length === 0 ? null : [...normalized].slice(0, 80).join("");
}

function unsafeFactorLabelCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function factorChoiceLabel(friendlyName: string | null, index: number): string {
  const ordinal = index + 1;
  return friendlyName === null
    ? `Authenticator ${ordinal}`
    : `${friendlyName} (Authenticator ${ordinal})`;
}

function decodeStatus<const Status extends string>(
  value: unknown,
  statuses: readonly Status[],
): Status | null {
  const result = snapshotExactRecord(value, ["status"]);
  return result !== null &&
    typeof result.status === "string" &&
    statuses.some((status) => status === result.status)
    ? (result.status as Status)
    : null;
}

function exactSingleRow(value: unknown): unknown {
  const rows = snapshotArray(value, 1);
  return rows !== null && rows.length === 1 ? rows[0] : null;
}

function decodeCurrentContext(value: unknown): CurrentContextResult {
  const rows = snapshotArray(value, 2);
  if (rows === null || rows.length !== 1) {
    throw new Error("Staff authentication context is ambiguous");
  }
  const row = snapshotExactRecord(rows[0], [
    "code",
    "display_name",
    "membership_role",
    "profile_id",
    "role_revision",
    "school_id",
    "school_name",
    "school_settings_revision",
    "school_slug",
  ]);
  if (row === null || typeof row.code !== "string") {
    throw new Error("Staff authentication context is unavailable");
  }
  if (row.code !== "ok") {
    const profileIdIsValidFailureValue =
      row.profile_id === null ||
      (row.code === "membership_inactive" && isCanonicalUuid(row.profile_id));
    if (
      row.display_name !== null ||
      row.membership_role !== null ||
      !profileIdIsValidFailureValue ||
      row.role_revision !== null ||
      row.school_id !== null ||
      row.school_name !== null ||
      row.school_settings_revision !== null ||
      row.school_slug !== null
    ) {
      throw new Error("Staff authentication context failure is malformed");
    }
    const kind = currentContextFailureKind(row.code);
    if (kind === undefined) {
      throw new Error("Staff authentication context failed");
    }
    return { kind };
  }
  const displayName = parseStaffDisplayName(row.display_name);
  const schoolLabel = parseSchoolDisplayName(row.school_name);
  if (
    displayName === null ||
    !isCanonicalUuid(row.profile_id) ||
    !isCanonicalUuid(row.school_id) ||
    schoolLabel === null ||
    typeof row.school_settings_revision !== "number" ||
    !Number.isSafeInteger(row.school_settings_revision) ||
    row.school_settings_revision < 1 ||
    typeof row.school_slug !== "string" ||
    row.school_slug.length > 100 ||
    !canonicalSlugPattern.test(row.school_slug) ||
    (row.membership_role !== "owner" &&
      row.membership_role !== "admin" &&
      row.membership_role !== "teacher") ||
    typeof row.role_revision !== "number" ||
    !Number.isSafeInteger(row.role_revision) ||
    row.role_revision < 1
  ) {
    throw new Error("Staff authentication context is malformed");
  }
  return {
    displayName,
    kind: "active",
    profileId: row.profile_id,
    role: row.membership_role,
    roleRevision: row.role_revision,
    schoolId: row.school_id,
    schoolLabel,
    schoolSettingsRevision: row.school_settings_revision,
  };
}

function currentContextFailureKind(
  code: string,
): Exclude<CurrentContextResult, { kind: "active" }>["kind"] | undefined {
  switch (code) {
    case "email_unverified":
      return "email_verification_required";
    case "membership_inactive":
      return "membership_inactive";
    case "session_expired":
      return "session_expired";
    case "session_revoked":
      return "session_revoked";
    case "unauthenticated":
      return "signed_out";
    default:
      return undefined;
  }
}

function sameIdentityFacts(left: IdentityFacts, right: IdentityFacts): boolean {
  return (
    left.accountId === right.accountId &&
    left.displayName === right.displayName &&
    left.email === right.email &&
    left.profileId === right.profileId &&
    left.role === right.role &&
    left.roleRevision === right.roleRevision &&
    left.schoolId === right.schoolId
  );
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && canonicalUuidPattern.test(value);
}

function isCanonicalEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    value === value.trim() &&
    value === value.toLowerCase() &&
    canonicalEmailPattern.test(value)
  );
}

function isPassword(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function isBase64Url(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function validOpaqueCredential(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    new TextEncoder().encode(value).byteLength <= maximumBytes &&
    !hasControlText(value)
  );
}

function validText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim() &&
    value.length <= maximumLength &&
    !hasControlText(value)
  );
}

function hasControlText(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function readNow(clock: { readonly now: () => number }): number {
  const now = clock.now();
  if (!Number.isFinite(now)) {
    throw new Error("Staff authentication clock is unavailable");
  }
  return now;
}

function trimMap<Key, Value>(map: Map<Key, Value>, maximumSize: number): void {
  while (map.size > maximumSize) {
    const oldest = map.keys().next().value as Key | undefined;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

function snapshotArray(
  value: unknown,
  maximumLength: number,
): unknown[] | null {
  try {
    if (!Array.isArray(value)) {
      return null;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximumLength
    ) {
      return null;
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1 ||
      !keys.includes("length") ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" &&
            (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)),
      )
    ) {
      return null;
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    return null;
  }
}

type ExactRecord = Readonly<Record<string, unknown>>;

function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
): ExactRecord | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}
