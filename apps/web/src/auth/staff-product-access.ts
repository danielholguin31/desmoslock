import type { SchoolSettings } from "@desmoslock/contracts";

import type { StaffRole } from "./staff-auth-controller.js";

/** Nonsecret verified authority; School presentation does not change this key. */
export interface StaffProductAuthority {
  readonly accountId: string;
  readonly profileId: string;
  readonly membershipId: string;
  readonly schoolId: string;
  readonly role: StaffRole;
  readonly assuranceLevel: "aal1" | "aal2";
  readonly identityGeneration: string;
  readonly sessionGeneration: string;
}

export interface StaffProductAccess {
  readonly authority: StaffProductAuthority;
  readonly school: SchoolSettings;
}

export type StaffProductAccessState =
  | { readonly kind: "ready"; readonly access: StaffProductAccess }
  | { readonly kind: "paused"; readonly authority: StaffProductAuthority }
  | { readonly kind: "unavailable" };

/** Only a completed, still-current authority read can produce fresh access. */
export type StaffProductRefreshResult =
  | { readonly kind: "fresh_authorized"; readonly access: StaffProductAccess }
  | { readonly kind: "paused" }
  | { readonly kind: "unavailable" };
