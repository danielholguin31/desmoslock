import {
  mapCurrentManageableStaffInvitationsRpcRows,
  mapCurrentManageableStaffRpcRows,
  mapStaffAuthInternalFailure,
  parseAcceptStaffInvitationRequest,
  parseAcceptStaffInvitationResponse,
  parseBeginStaffPasswordRecoveryRpcResult,
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
  parseStaffDisplayName,
  staffAuthRpcFailureCodes,
  type AcceptStaffInvitationRequest,
  type BeginStaffPasswordRecoveryRpcResult,
  type CreateStaffInvitationRequest,
  type FinishStaffPasswordRecoveryRpcResult,
  type ManageableStaffInvitation,
  type ManageableStaffMember,
  type RequestStaffPasswordRecoveryRequest,
  type RevokeStaffInvitationRequest,
  type RevokeStaffMembershipRequest,
} from "@desmoslock/contracts";

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

export interface SupabaseStaffAuthPort {
  acceptInvitation(request: AcceptStaffInvitationRequest): Promise<unknown>;
  beginPasswordRecovery(operationId: string): Promise<unknown>;
  challengeTotp(factorId: string): Promise<unknown>;
  enrollTotp(): Promise<unknown>;
  exchangeRecoveryCode(input: {
    readonly authorizationCode: string;
    readonly verifier: string;
  }): Promise<unknown>;
  finishPasswordRecovery(operationId: string): Promise<unknown>;
  invokeInvitation(request: CreateStaffInvitationRequest): Promise<unknown>;
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
  revokeAllStaffSessions(): Promise<unknown>;
  revokeCurrentStaffSession(): Promise<unknown>;
  revokeInvitation(request: RevokeStaffInvitationRequest): Promise<unknown>;
  revokeMembership(request: RevokeStaffMembershipRequest): Promise<unknown>;
  signIn(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<unknown>;
  signOut(scope: "all" | "local"): Promise<unknown>;
  updatePassword(password: string): Promise<unknown>;
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
  let identityGeneration: string | null = null;
  let identityFacts: IdentityFacts | null = null;
  let pendingVerificationEmail: string | null = null;
  const challengeReceipts = new Map<string, ChallengeReceipt>();
  const enrollmentReceipts = new Map<string, EnrollmentReceipt>();
  const invitationReceipts = new Map<string, InvitationReceipt>();
  const listeners = new Set<(event: StaffAuthAccessEvent) => void>();
  const activePresentations = new Set<RevocablePresentation>();
  const completedOperations = new Map<string, CompletedOperation>();
  const inFlightOperations = new Map<
    string,
    {
      readonly promise: Promise<StaffAuthMutationResult>;
      readonly type: string;
    }
  >();
  let eventRevision = 0;
  let processedEventRevision = 0;
  let eventRead: Promise<void> | null = null;
  let activeMutations = 0;

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

  function clearAuthorityState(): void {
    sessionGeneration = null;
    identityGeneration = null;
    identityFacts = null;
    challengeReceipts.clear();
    clearEnrollmentReceipts(true);
  }

  async function readAuthority(
    options: { readonly rotateSession?: boolean } = {},
  ): Promise<StaffAuthBoundaryResult> {
    const session = snapshotExactRecord(await dependencies.port.readSession(), [
      "status",
    ]);
    if (session?.status === "signed_out") {
      clearAuthorityState();
      invitationReceipts.clear();
      return { kind: "signed_out" };
    }
    if (session?.status !== "authenticated") {
      throw new Error("Staff authentication session result is unavailable");
    }
    const candidateSessionGeneration =
      sessionGeneration === null || options.rotateSession === true
        ? nextGeneration()
        : sessionGeneration;

    const account = decodeAccount(await dependencies.port.readAccount());
    if (account === null) {
      throw new Error("Staff authentication account result is unavailable");
    }
    if (!account.emailVerified) {
      sessionGeneration = candidateSessionGeneration;
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
      identityGeneration = null;
      identityFacts = null;
      challengeReceipts.clear();
      clearEnrollmentReceipts(true);
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
      schoolLabel: context.schoolLabel,
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
      school: { id: context.schoolId, label: context.schoolLabel },
    };
    let manageableInvitations: StaffAuthBoundaryManagedInvitation[] = [];
    let manageableStaff: StaffAuthBoundaryManagedStaff[] = [];
    if (context.role === "owner" && assurance.currentLevel === "aal2") {
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
      manageableStaff = staff.items
        .filter((entry) => entry.schoolId === context.schoolId)
        .map(mapManagedStaff);
      manageableInvitations = invitations.items
        .filter((entry) => entry.schoolId === context.schoolId)
        .map(mapManagedInvitation);
    }
    const base: Omit<
      StaffAuthAccessGrant,
      "challengeReceipt" | "secondFactor"
    > = {
      assuranceLevel: assurance.currentLevel,
      identity,
      identityGeneration: candidateIdentityGeneration,
      kind: "access_granted",
      manageableInvitations,
      manageableStaff,
      sessionGeneration: candidateSessionGeneration,
    };
    let result: StaffAuthAccessGrant;
    let pendingChallenge: {
      readonly factorId: string;
      readonly receipt: string;
    } | null = null;
    if (context.role === "teacher" || assurance.currentLevel === "aal2") {
      result = { ...base, secondFactor: "satisfied" };
    } else {
      if (assurance.nextLevel !== "aal2") {
        throw new Error("Privileged staff assurance is unavailable");
      }
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
        const factor = verified.length === 1 ? verified[0] : undefined;
        if (factor === undefined) {
          throw new Error("Staff authentication factors are ambiguous");
        }
        const challengeReceipt = nextGeneration();
        pendingChallenge = {
          factorId: factor.factorId,
          receipt: challengeReceipt,
        };
        result = {
          ...base,
          challengeReceipt,
          secondFactor: "challenge_required",
        };
      }
    }
    if (identityChanged || sessionChanged) {
      challengeReceipts.clear();
      clearEnrollmentReceipts(true);
    }
    if (pendingChallenge !== null) {
      challengeReceipts.set(pendingChallenge.receipt, {
        expiresAt: readNow(dependencies.clock) + 5 * 60 * 1000,
        factorId: pendingChallenge.factorId,
        identityGeneration: candidateIdentityGeneration,
        sessionGeneration: candidateSessionGeneration,
      });
      trimMap(challengeReceipts, 16);
    }
    sessionGeneration = candidateSessionGeneration;
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
        result = {
          kind:
            response === "ready"
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
    } else if (request.type === "accept_invitation") {
      result = await acceptInvitation(request);
    } else if (request.type === "begin_totp_enrollment") {
      result = await beginTotpEnrollment(request.operationId);
    } else if (request.type === "verify_totp") {
      result = await verifyTotpMutation(request);
    } else if (request.type === "sign_out") {
      result = await signOut(request.scope);
    } else if (request.type === "create_staff_invitation") {
      result = await createStaffInvitation(request);
    } else if (request.type === "revoke_staff_invitation") {
      result = await revokeStaffInvitation(request);
    } else if (request.type === "revoke_staff_membership") {
      result = await revokeStaffMembership(request);
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
    const invitation = decodeCurrentInvitation(
      await dependencies.port.readCurrentInvitations(),
    );
    if (invitation.kind !== "ready") {
      return { kind: "invitation_rejected", reason: invitation.reason };
    }
    if (invitation.expiresAtMilliseconds <= readNow(dependencies.clock)) {
      return { kind: "invitation_rejected", reason: "expired" };
    }
    const acceptanceReceipt = nextGeneration();
    if (invitationReceipts.has(acceptanceReceipt)) {
      throw new Error("Invitation receipt generation collided");
    }
    invitationReceipts.set(acceptanceReceipt, {
      accountId: verification.accountId,
      email: verification.email,
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
      intendedAccountId: verification.accountId,
      intendedEmail: verification.email,
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
    const password = decodeStatus(
      await dependencies.port.updatePassword(request.password),
      ["updated", "rejected"],
    );
    if (password === null) {
      throw new Error("Invitation password result is malformed");
    }
    if (password === "rejected") {
      return { kind: "invitation_rejected", reason: "invalid" };
    }
    const response = parseAcceptStaffInvitationResponse(
      productRpcResponse(
        exactSingleRow(await dependencies.port.acceptInvitation(acceptance)),
        "invitation_accepted",
      ),
    );
    if (response === null) {
      throw new Error("Invitation acceptance result is malformed");
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
    const access = await readAuthority();
    if (
      access.kind !== "access_granted" ||
      access.identity.accountId !== receipt.accountId ||
      access.identity.email !== receipt.email ||
      access.identity.school.id !== receipt.schoolId ||
      access.identity.membership.role !== receipt.role
    ) {
      throw new Error("Invitation acceptance authority continuity failed");
    }
    return access;
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
    const revocationRows =
      scope === "all"
        ? await dependencies.port.revokeAllStaffSessions()
        : await dependencies.port.revokeCurrentStaffSession();
    const revocationCode = decodeRpcCode(revocationRows);
    if (revocationCode !== "ok" && revocationCode !== "session_revoked") {
      const loss = boundaryFailure(revocationCode);
      if (loss !== null) {
        return loss;
      }
      throw new Error("Application session revocation is unavailable");
    }
    const providerResult = decodeStatus(
      await dependencies.port.signOut(scope),
      ["signed_out"],
    );
    if (providerResult !== "signed_out") {
      throw new Error("Provider sign-out is unavailable");
    }
    clearAuthorityState();
    invitationReceipts.clear();
    pendingVerificationEmail = null;
    return { kind: "sign_out_complete", scope };
  }

  async function createStaffInvitation(
    request: Extract<
      StaffAuthMutation,
      { readonly type: "create_staff_invitation" }
    >,
  ): Promise<StaffAuthBoundaryResult> {
    const actor = await readOwnerActor(request.schoolId);
    if (actor.kind !== "access_granted") {
      return actor;
    }
    const input = parseCreateStaffInvitationRequest({
      email: request.email,
      role:
        request.targetRole === "admin" ? "administrator" : request.targetRole,
      schoolId: request.schoolId,
    });
    if (input === null) {
      return { actor, kind: "staff_invitation_rejected" };
    }
    const response = parseCreateStaffInvitationResponse(
      await dependencies.port.invokeInvitation(input),
    );
    if (response === null) {
      throw new Error("Staff invitation result is malformed");
    }
    const refreshed = await readSameOwnerActor(actor);
    if (refreshed.kind !== "access_granted") {
      return refreshed;
    }
    if (!response.ok) {
      const loss = boundaryFailure(response.code);
      return loss ?? { actor: refreshed, kind: "staff_invitation_rejected" };
    }
    return {
      actor: refreshed,
      invitedRole: request.targetRole,
      kind: "staff_invitation_created",
    };
  }

  async function revokeStaffInvitation(
    request: Extract<
      StaffAuthMutation,
      { readonly type: "revoke_staff_invitation" }
    >,
  ): Promise<StaffAuthBoundaryResult> {
    const actor = await readOwnerActor(request.schoolId);
    if (actor.kind !== "access_granted") {
      return actor;
    }
    const target = actor.manageableInvitations.find(
      (entry) =>
        entry.invitationId === request.invitationId &&
        entry.schoolId === request.schoolId,
    );
    const input = parseRevokeStaffInvitationRequest({
      invitationId: request.invitationId,
    });
    if (input === null || target === undefined) {
      return { actor, kind: "staff_invitation_revocation_rejected" };
    }
    const response = parseRevokeStaffInvitationResponse(
      productRpcResponse(
        exactSingleRow(await dependencies.port.revokeInvitation(input)),
        "invitation_revoked",
      ),
    );
    if (response === null) {
      throw new Error("Staff invitation revocation result is malformed");
    }
    const refreshed = await readSameOwnerActor(actor);
    if (refreshed.kind !== "access_granted") {
      return refreshed;
    }
    if (!response.ok) {
      const loss = boundaryFailure(response.code);
      return (
        loss ?? {
          actor: refreshed,
          kind: "staff_invitation_revocation_rejected",
        }
      );
    }
    return {
      actor: refreshed,
      invitationId: request.invitationId,
      kind: "staff_invitation_revoked",
      revokedRole: target.role,
      schoolId: request.schoolId,
    };
  }

  async function revokeStaffMembership(
    request: Extract<
      StaffAuthMutation,
      { readonly type: "revoke_staff_membership" }
    >,
  ): Promise<StaffAuthBoundaryResult> {
    const actor = await readOwnerActor(request.schoolId);
    if (actor.kind !== "access_granted") {
      return actor;
    }
    const target = actor.manageableStaff.find(
      (entry) =>
        entry.profile.id === request.profileId &&
        entry.schoolId === request.schoolId,
    );
    const input = parseRevokeStaffMembershipRequest({
      profileId: request.profileId,
      schoolId: request.schoolId,
    });
    if (input === null || target === undefined) {
      return { actor, kind: "staff_membership_revocation_rejected" };
    }
    const response = parseRevokeStaffMembershipResponse(
      productRpcResponse(
        exactSingleRow(await dependencies.port.revokeMembership(input)),
        "membership_revoked",
      ),
    );
    if (response === null) {
      throw new Error("Staff membership revocation result is malformed");
    }
    const refreshed = await readSameOwnerActor(actor);
    if (refreshed.kind !== "access_granted") {
      return refreshed;
    }
    if (!response.ok) {
      const loss = boundaryFailure(response.code);
      return (
        loss ?? {
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
  }

  async function readOwnerActor(
    schoolId: string,
  ): Promise<StaffAuthBoundaryResult> {
    const authority = await readAuthority();
    if (authority.kind !== "access_granted") {
      return authority;
    }
    if (
      authority.identity.school.id !== schoolId ||
      authority.identity.membership.role !== "owner"
    ) {
      return { kind: "membership_inactive" };
    }
    if (
      authority.assuranceLevel !== "aal2" ||
      authority.secondFactor !== "satisfied"
    ) {
      return { kind: "step_up_required" };
    }
    return authority;
  }

  async function readSameOwnerActor(
    expected: StaffAuthAccessGrant,
  ): Promise<StaffAuthBoundaryResult> {
    const authority = await readOwnerActor(expected.identity.school.id);
    if (authority.kind !== "access_granted") {
      return authority;
    }
    if (!sameAccessAuthority(authority, expected)) {
      throw new Error("Staff management actor continuity failed");
    }
    return authority;
  }

  async function completePasswordRecovery(
    operationId: string,
    password: string,
  ): Promise<StaffAuthBoundaryResult> {
    if (!isPassword(password)) {
      return { kind: "password_recovery_rejected" };
    }
    const begin = parseBeginStaffPasswordRecoveryRpcResult(
      exactSingleRow(
        await dependencies.port.beginPasswordRecovery(operationId),
      ),
    );
    if (begin === null) {
      throw new Error("Password recovery begin result is malformed");
    }
    if (!begin.ok) {
      return passwordRecoveryFailure(begin);
    }
    if (begin.operationId !== operationId) {
      throw new Error("Password recovery operation continuity failed");
    }
    if (begin.code === "recovery_sessions_revoked") {
      const update = decodeStatus(
        await dependencies.port.updatePassword(password),
        ["updated", "rejected"],
      );
      if (update === null) {
        throw new Error("Password update result is malformed");
      }
      if (update === "rejected") {
        return { kind: "password_recovery_rejected" };
      }
      const finish = parseFinishStaffPasswordRecoveryRpcResult(
        exactSingleRow(
          await dependencies.port.finishPasswordRecovery(operationId),
        ),
      );
      if (finish === null) {
        throw new Error("Password recovery finish result is malformed");
      }
      if (!finish.ok) {
        return passwordRecoveryFailure(finish);
      }
    }
    const signOut = decodeStatus(await dependencies.port.signOut("all"), [
      "signed_out",
    ]);
    if (signOut !== "signed_out") {
      throw new Error("Global recovery sign-out is unavailable");
    }
    sessionGeneration = null;
    identityGeneration = null;
    identityFacts = null;
    challengeReceipts.clear();
    return { kind: "password_recovery_complete", sessionScope: "all" };
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

  function scheduleAuthorityEventRead(): void {
    if (
      disposed ||
      activeMutations > 0 ||
      eventRead !== null ||
      eventRevision <= processedEventRevision
    ) {
      return;
    }
    let targetRevision = processedEventRevision;
    eventRead = Promise.resolve()
      .then(async () => {
        targetRevision = eventRevision;
        const previousSessionGeneration = sessionGeneration;
        const previousIdentityGeneration = identityGeneration;
        if (
          previousSessionGeneration === null ||
          previousIdentityGeneration === null
        ) {
          return;
        }
        let authority: StaffAuthBoundaryResult;
        try {
          authority = await readAuthority({ rotateSession: true });
        } catch {
          return;
        }
        if (disposed) {
          clearAuthorityState();
          return;
        }
        if (authority.kind === "access_granted") {
          emitEvent({
            access: authority,
            kind: "access_changed",
            previousIdentityGeneration,
            previousSessionGeneration,
          });
          return;
        }
        if (
          authority.kind === "membership_inactive" ||
          authority.kind === "session_expired" ||
          authority.kind === "session_revoked" ||
          authority.kind === "signed_out"
        ) {
          emitEvent({
            identityGeneration: previousIdentityGeneration,
            kind: authority.kind,
            sessionGeneration: previousSessionGeneration,
          });
        }
      })
      .finally(() => {
        processedEventRevision = Math.max(
          processedEventRevision,
          targetRevision,
        );
        eventRead = null;
        if (!disposed && eventRevision > processedEventRevision) {
          scheduleAuthorityEventRead();
        }
      });
  }

  const unsubscribeProvider = dependencies.port.onAuthStateChange(() => {
    if (disposed) {
      return;
    }
    eventRevision += 1;
    scheduleAuthorityEventRead();
  });

  return {
    async read() {
      if (disposed) {
        throw new Error("Staff authentication adapter is disposed");
      }
      const result = await readAuthority();
      if (disposed) {
        throw new Error("Staff authentication adapter is disposed");
      }
      return result;
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
      const completed = completedOperations.get(request.operationId);
      if (completed !== undefined) {
        if (completed.type !== request.type) {
          throw new Error("Staff authentication operation was reused");
        }
        if (completed.result === null) {
          throw new Error("Staff authentication operation requires re-entry");
        }
        return { operationId: request.operationId, result: completed.result };
      }
      const inFlight = inFlightOperations.get(request.operationId);
      if (inFlight !== undefined) {
        if (inFlight.type !== request.type) {
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
            result: requiresCredentialReentry(result.result)
              ? null
              : result.result,
            type: operationType,
          });
          trimMap(completedOperations, 64);
          return result;
        })
        .finally(() => {
          inFlightOperations.delete(operationId);
          activeMutations -= 1;
          scheduleAuthorityEventRead();
        });
      inFlightOperations.set(operationId, {
        promise,
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
      eventRevision += 1;
      try {
        unsubscribeProvider();
      } catch {
        // Provider unsubscription is best-effort after fail-closed disposal.
      }
      listeners.clear();
      completedOperations.clear();
      inFlightOperations.clear();
      challengeReceipts.clear();
      clearEnrollmentReceipts(true);
      invitationReceipts.clear();
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
  readonly schoolLabel: string;
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
    state: "pending",
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
    left.identity.accountId === right.identity.accountId &&
    left.identity.email === right.identity.email &&
    left.identity.membership.id === right.identity.membership.id &&
    left.identity.membership.role === right.identity.membership.role &&
    left.identity.membership.status === right.identity.membership.status &&
    left.identity.profile.displayName === right.identity.profile.displayName &&
    left.identity.profile.id === right.identity.profile.id &&
    left.identity.school.id === right.identity.school.id &&
    left.identity.school.label === right.identity.school.label
  );
}

function requiresCredentialReentry(result: StaffAuthBoundaryResult): boolean {
  return (
    result.kind === "access_granted" ||
    result.kind === "invitation_ready" ||
    result.kind === "totp_enrollment_ready" ||
    result.kind === "staff_invitation_created" ||
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
  readonly email: string;
  readonly emailVerified: boolean;
} | null {
  const account = snapshotExactRecord(value, [
    "accountId",
    "email",
    "emailVerified",
  ]);
  return account !== null &&
    isCanonicalUuid(account.accountId) &&
    isCanonicalEmail(account.email) &&
    typeof account.emailVerified === "boolean"
    ? {
        accountId: account.accountId,
        email: account.email,
        emailVerified: account.emailVerified,
      }
    : null;
}

function decodeAssurance(value: unknown): {
  readonly currentLevel: "aal1" | "aal2";
  readonly nextLevel: "aal1" | "aal2";
} | null {
  const assurance = snapshotExactRecord(value, ["currentLevel", "nextLevel"]);
  if (
    assurance === null ||
    (assurance.currentLevel !== "aal1" && assurance.currentLevel !== "aal2") ||
    (assurance.nextLevel !== "aal1" && assurance.nextLevel !== "aal2") ||
    (assurance.currentLevel === "aal2" && assurance.nextLevel !== "aal2")
  ) {
    return null;
  }
  return {
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
    const row = snapshotExactRecord(valueRow, ["factorId", "status"]);
    if (
      row === null ||
      !isCanonicalUuid(row.factorId) ||
      (row.status !== "unverified" && row.status !== "verified") ||
      ids.has(row.factorId)
    ) {
      return null;
    }
    ids.add(row.factorId);
    factors.push({ factorId: row.factorId, status: row.status });
  }
  return factors;
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
    "school_slug",
  ]);
  if (row === null || typeof row.code !== "string") {
    throw new Error("Staff authentication context is unavailable");
  }
  if (row.code !== "ok") {
    if (
      row.display_name !== null ||
      row.membership_role !== null ||
      row.profile_id !== null ||
      row.role_revision !== null ||
      row.school_id !== null ||
      row.school_name !== null ||
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
  if (
    displayName === null ||
    !isCanonicalUuid(row.profile_id) ||
    !isCanonicalUuid(row.school_id) ||
    !validText(row.school_name, 200) ||
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
    schoolLabel: row.school_name,
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
    left.schoolId === right.schoolId &&
    left.schoolLabel === right.schoolLabel
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
