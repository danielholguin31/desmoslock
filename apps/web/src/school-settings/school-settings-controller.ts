import {
  parseSchoolSettings,
  parseUpdateSchoolDisplayNameRpcResult,
  validateSchoolDisplayNameDraft,
} from "@desmoslock/contracts";

import type {
  SchoolNameValidation,
  SchoolSettings,
  UpdateSchoolDisplayNameRequest,
} from "@desmoslock/contracts";

import type {
  StaffProductAccessState,
  StaffProductAuthority,
  StaffProductRefreshResult,
} from "../auth/staff-product-access.js";

export type SchoolSettingsNotice =
  "updated" | "unchanged" | "rejected" | "unconfirmed";

export type SchoolSettingsSnapshot = { readonly revision: number } & (
  | { readonly kind: "unavailable" | "paused" }
  | { readonly kind: "read_only"; readonly school: SchoolSettings }
  | {
      readonly kind: "editing";
      readonly school: SchoolSettings;
      readonly draft: string;
      readonly validation: SchoolNameValidation | null;
      readonly notice: SchoolSettingsNotice | null;
    }
  | {
      readonly kind: "saving";
      readonly school: SchoolSettings;
      readonly draft: string;
      readonly phase: "verifying" | "submitting" | "refreshing";
    }
  | {
      readonly kind: "conflict";
      readonly current: SchoolSettings;
      readonly draft: string;
      readonly notice: SchoolSettingsNotice | null;
    }
);

export type SchoolSettingsAction =
  | { readonly type: "edit_name"; readonly value: string }
  | { readonly type: "save"; readonly snapshotRevision: number }
  | { readonly type: "refresh" }
  | {
      readonly type: "use_current_name" | "keep_draft";
      readonly snapshotRevision: number;
    };

export interface SchoolSettingsPort {
  captureSchoolSettingsAuthority(expectedAccountId: string): Promise<unknown>;
  updateSchoolDisplayName(
    request: UpdateSchoolDisplayNameRequest,
    authorityHandle: string,
  ): Promise<unknown>;
  releaseSchoolSettingsAuthority(authorityHandle: string): void;
}

export interface SchoolSettingsController {
  getSnapshot(): SchoolSettingsSnapshot;
  subscribe(listener: (snapshot: SchoolSettingsSnapshot) => void): () => void;
  setAccess(access: StaffProductAccessState): void;
  dispatch(action: SchoolSettingsAction): Promise<SchoolSettingsSnapshot>;
  dispose(): void;
}

export interface SchoolSettingsControllerDependencies {
  readonly port: SchoolSettingsPort;
  readonly refreshAccess: () => Promise<StaffProductRefreshResult>;
  readonly getAccess: () => StaffProductAccessState;
}

interface SaveIntent {
  readonly epoch: number;
  readonly authority: StaffProductAuthority;
  readonly baseline: SchoolSettings;
  readonly request: UpdateSchoolDisplayNameRequest;
  handle: string | null;
  egressStarted: boolean;
  phase: "verifying" | "submitting" | "refreshing";
}

type SnapshotBody = SchoolSettingsSnapshot extends infer Snapshot
  ? Snapshot extends SchoolSettingsSnapshot
    ? Omit<Snapshot, "revision">
    : never
  : never;

export function createSchoolSettingsController(
  dependencies: SchoolSettingsControllerDependencies,
): SchoolSettingsController {
  let disposed = false;
  let epoch = 0;
  let snapshot: SchoolSettingsSnapshot = Object.freeze({
    kind: "unavailable",
    revision: 0,
  });
  let mode: StaffProductAccessState["kind"] = "unavailable";
  let authority: StaffProductAuthority | null = null;
  let current: SchoolSettings | null = null;
  let baseline: SchoolSettings | null = null;
  let draft: string | null = null;
  let validation: SchoolNameValidation | null = null;
  let notice: SchoolSettingsNotice | null = null;
  let conflicted = false;
  let operation: SaveIntent | null = null;
  const listeners = new Set<(snapshot: SchoolSettingsSnapshot) => void>();

  function publish(body: SnapshotBody): void {
    if (disposed) return;
    if (
      JSON.stringify({ ...body, revision: 0 }) ===
      JSON.stringify({ ...snapshot, revision: 0 })
    )
      return;
    snapshot = Object.freeze({ ...body, revision: snapshot.revision + 1 });
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        /* A view cannot change operation settlement. */
      }
    }
  }

  function release(intent: SaveIntent): void {
    const handle = intent.handle;
    intent.handle = null;
    if (handle !== null) {
      try {
        dependencies.port.releaseSchoolSettingsAuthority(handle);
      } catch {
        /* The bounded port also expires handles. */
      }
    }
  }

  function invalidate(retainDraft: boolean): void {
    epoch += 1;
    if (operation !== null) {
      if (retainDraft && operation.egressStarted) notice = "unconfirmed";
      release(operation);
      operation = null;
    }
    if (!retainDraft) {
      authority = null;
      current = null;
      baseline = null;
      draft = null;
      validation = null;
      notice = null;
      conflicted = false;
    }
  }

  function project(): void {
    if (mode !== "ready") {
      publish({ kind: mode });
      return;
    }
    if (authority === null || current === null) {
      publish({ kind: "unavailable" });
      return;
    }
    if (!canEdit(authority)) {
      publish({ kind: "read_only", school: current });
      return;
    }
    if (operation !== null) {
      publish({
        kind: "saving",
        school: current,
        draft: operation.request.displayName,
        phase: operation.phase,
      });
      return;
    }
    if (baseline === null || draft === null) {
      baseline = current;
      draft = current.displayName;
    }
    if (!conflicted && draft === baseline.displayName) {
      baseline = current;
      draft = current.displayName;
    } else if (current.settingsRevision !== baseline.settingsRevision)
      conflicted = true;
    if (conflicted) publish({ kind: "conflict", current, draft, notice });
    else
      publish({ kind: "editing", school: current, draft, validation, notice });
  }

  function setAccess(access: StaffProductAccessState): void {
    if (disposed) return;
    if (access.kind === "unavailable") {
      invalidate(false);
      mode = "unavailable";
      project();
      return;
    }
    if (access.kind === "paused") {
      const retain =
        authority !== null && sameAuthority(authority, access.authority);
      invalidate(retain);
      authority = Object.freeze({ ...access.authority });
      mode = "paused";
      project();
      return;
    }
    const settings = parseSchoolSettings(access.access.school);
    if (
      settings === null ||
      settings.schoolId !== access.access.authority.schoolId
    ) {
      setAccess({ kind: "unavailable" });
      return;
    }
    const same =
      authority !== null && sameAuthority(authority, access.access.authority);
    if (!same) invalidate(false);
    authority = Object.freeze({ ...access.access.authority });
    if (same && current !== null) {
      if (settings.settingsRevision < current.settingsRevision) {
        mode = "ready";
        project();
        return;
      }
      if (
        settings.settingsRevision === current.settingsRevision &&
        settings.displayName !== current.displayName
      ) {
        setAccess({ kind: "unavailable" });
        return;
      }
    }
    current = Object.freeze(settings);
    mode = "ready";
    // During every save phase, project uses only the immutable intent. A
    // synchronous auth publication may update presentation but cannot settle it.
    project();
  }

  function readLiveAccess(): StaffProductAccessState {
    try {
      return dependencies.getAccess();
    } catch {
      return { kind: "unavailable" };
    }
  }

  function isCurrent(intent: SaveIntent): boolean {
    return (
      !disposed &&
      operation === intent &&
      epoch === intent.epoch &&
      mode === "ready" &&
      authority !== null &&
      sameAuthority(authority, intent.authority)
    );
  }

  function checkLive(intent: SaveIntent): boolean {
    if (!isCurrent(intent)) return false;
    setAccess(readLiveAccess());
    return isCurrent(intent);
  }

  async function refresh(): Promise<StaffProductRefreshResult> {
    try {
      return await dependencies.refreshAccess();
    } catch {
      return { kind: "unavailable" };
    }
  }

  function adoptFresh(
    intent: SaveIntent,
    result: StaffProductRefreshResult,
  ): boolean {
    if (!isCurrent(intent)) return false;
    const live = readLiveAccess();
    if (
      live.kind !== "ready" ||
      !sameAuthority(live.access.authority, intent.authority)
    ) {
      setAccess(live);
      return false;
    }
    if (result.kind === "unavailable") {
      setAccess({ kind: "unavailable" });
      return false;
    }
    if (result.kind === "paused") {
      setAccess({ kind: "paused", authority: intent.authority });
      return false;
    }
    if (!sameAuthority(result.access.authority, intent.authority)) {
      setAccess({ kind: "unavailable" });
      return false;
    }
    setAccess({ kind: "ready", access: result.access });
    if (!isCurrent(intent)) return false;
    setAccess(live);
    return isCurrent(intent);
  }

  function finishConflict(
    intent: SaveIntent,
    resultNotice: SchoolSettingsNotice | null,
  ): void {
    if (!isCurrent(intent)) return;
    operation = null;
    baseline = intent.baseline;
    draft = intent.request.displayName;
    conflicted = true;
    validation = null;
    notice = resultNotice;
    project();
  }

  function phase(intent: SaveIntent, value: SaveIntent["phase"]): void {
    if (!isCurrent(intent)) return;
    intent.phase = value;
    project();
  }

  async function settle(
    intent: SaveIntent,
    outcome: "updated" | "unchanged" | "rejected" | "unconfirmed" | "conflict",
  ): Promise<void> {
    if (!isCurrent(intent)) return;
    phase(intent, "refreshing");
    if (!isCurrent(intent)) return;
    const refreshed = await refresh();
    if (!adoptFresh(intent, refreshed) || current === null) return;
    if (outcome === "conflict") {
      finishConflict(intent, null);
      return;
    }
    if (outcome === "updated" || outcome === "unchanged") {
      const expectedRevision =
        intent.baseline.settingsRevision + (outcome === "updated" ? 1 : 0);
      if (
        current.settingsRevision !== expectedRevision ||
        current.displayName !== intent.request.displayName
      ) {
        finishConflict(intent, outcome);
        return;
      }
      baseline = current;
      draft = current.displayName;
      conflicted = false;
    } else {
      baseline = intent.baseline;
      draft = intent.request.displayName;
      conflicted = current.settingsRevision !== baseline.settingsRevision;
    }
    operation = null;
    validation = null;
    notice = outcome;
    project();
  }

  async function save(
    snapshotRevision: number,
  ): Promise<SchoolSettingsSnapshot> {
    if (
      disposed ||
      operation !== null ||
      snapshot.kind !== "editing" ||
      snapshotRevision !== snapshot.revision ||
      authority === null ||
      current === null ||
      baseline === null ||
      draft === null ||
      !canEdit(authority)
    )
      return snapshot;
    const checked = validateSchoolDisplayNameDraft(draft);
    if (!checked.ok) {
      validation = checked.reason;
      project();
      return snapshot;
    }
    // Everything authorized by this Save is captured synchronously, before its
    // first await. No refreshed label or later account can rebase the request.
    epoch += 1;
    const intent: SaveIntent = {
      epoch,
      authority: Object.freeze({ ...authority }),
      baseline: Object.freeze({ ...baseline }),
      request: Object.freeze({
        schoolId: authority.schoolId,
        displayName: checked.displayName,
        expectedSettingsRevision: baseline.settingsRevision,
      }),
      handle: null,
      egressStarted: false,
      phase: "verifying",
    };
    operation = intent;
    validation = null;
    notice = null;
    project();
    try {
      if (!isCurrent(intent)) return snapshot;
      const fresh = await refresh();
      if (!adoptFresh(intent, fresh) || !checkLive(intent) || current === null)
        return snapshot;
      if (current.settingsRevision !== intent.baseline.settingsRevision) {
        finishConflict(intent, null);
        return snapshot;
      }
      let captured: unknown;
      try {
        captured = await dependencies.port.captureSchoolSettingsAuthority(
          intent.authority.accountId,
        );
      } catch {
        captured = null;
      }
      intent.handle = readyHandle(captured);
      if (!checkLive(intent) || current === null) return snapshot;
      if (current.settingsRevision !== intent.baseline.settingsRevision) {
        finishConflict(intent, null);
        return snapshot;
      }
      if (intent.handle === null) {
        await settle(intent, "rejected");
        return snapshot;
      }
      phase(intent, "submitting");
      // Publishing pending state can synchronously cause access to pause.
      if (!checkLive(intent) || current === null) return snapshot;
      if (current.settingsRevision !== intent.baseline.settingsRevision) {
        finishConflict(intent, null);
        return snapshot;
      }
      intent.egressStarted = true;
      let raw: unknown;
      try {
        raw = await dependencies.port.updateSchoolDisplayName(
          intent.request,
          intent.handle,
        );
      } catch {
        raw = null;
      }
      if (!isCurrent(intent)) return snapshot;
      const response = parseUpdateSchoolDisplayNameRpcResult(raw);
      const outcome =
        response === null ||
        (!response.ok && response.code === "dependency_unavailable")
          ? "unconfirmed"
          : response.ok
            ? response.code === "school_display_name_updated"
              ? "updated"
              : "unchanged"
            : response.code === "school_settings_revision_conflict"
              ? "conflict"
              : "rejected";
      await settle(intent, outcome);
      return snapshot;
    } finally {
      release(intent);
    }
  }

  async function explicitRefresh(): Promise<SchoolSettingsSnapshot> {
    if (disposed || operation !== null) return snapshot;
    epoch += 1;
    const startingEpoch = epoch;
    const result = await refresh();
    if (disposed || epoch !== startingEpoch || operation !== null)
      return snapshot;
    const live = readLiveAccess();
    if (live.kind !== "ready") {
      setAccess(live);
      return snapshot;
    }
    if (result.kind === "unavailable") setAccess({ kind: "unavailable" });
    else if (result.kind === "paused")
      setAccess({ kind: "paused", authority: live.access.authority });
    else if (sameAuthority(result.access.authority, live.access.authority)) {
      setAccess({ kind: "ready", access: result.access });
      if (mode === "ready") setAccess(live);
    } else setAccess(live);
    return snapshot;
  }

  setAccess(readLiveAccess());
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setAccess,
    async dispatch(action) {
      if (disposed) return snapshot;
      if (action.type === "save") return save(action.snapshotRevision);
      if (action.type === "refresh") return explicitRefresh();
      if (
        operation !== null ||
        mode !== "ready" ||
        authority === null ||
        !canEdit(authority)
      )
        return snapshot;
      if (action.type === "edit_name") {
        if (snapshot.kind !== "editing" && snapshot.kind !== "conflict")
          return snapshot;
        draft = action.value;
        validation = null;
        notice = null;
        project();
        return snapshot;
      }
      if (
        snapshot.kind !== "conflict" ||
        action.snapshotRevision !== snapshot.revision
      )
        return snapshot;
      setAccess(readLiveAccess());
      if (
        snapshot.kind !== "conflict" ||
        action.snapshotRevision !== snapshot.revision ||
        current === null
      )
        return snapshot;
      baseline = current;
      if (action.type === "use_current_name") draft = current.displayName;
      conflicted = false;
      notice = null;
      validation = null;
      project();
      return snapshot;
    },
    dispose() {
      if (disposed) return;
      invalidate(false);
      mode = "unavailable";
      snapshot = Object.freeze({
        kind: "unavailable",
        revision: snapshot.revision + 1,
      });
      disposed = true;
      listeners.clear();
    },
  };
}

function canEdit(authority: StaffProductAuthority): boolean {
  return (
    (authority.role === "owner" || authority.role === "administrator") &&
    authority.assuranceLevel === "aal2"
  );
}

function sameAuthority(
  left: StaffProductAuthority,
  right: StaffProductAuthority,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.profileId === right.profileId &&
    left.membershipId === right.membershipId &&
    left.schoolId === right.schoolId &&
    left.role === right.role &&
    left.assuranceLevel === right.assuranceLevel &&
    left.identityGeneration === right.identityGeneration &&
    left.sessionGeneration === right.sessionGeneration
  );
}

function readyHandle(value: unknown): string | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      !keys.includes("status") ||
      !keys.includes("authorityHandle")
    )
      return null;
    const status = Object.getOwnPropertyDescriptor(value, "status");
    const handle = Object.getOwnPropertyDescriptor(value, "authorityHandle");
    return status !== undefined &&
      handle !== undefined &&
      status.enumerable &&
      handle.enumerable &&
      "value" in status &&
      status.value === "ready" &&
      "value" in handle &&
      typeof handle.value === "string" &&
      /^[A-Za-z0-9_-]{1,256}$/u.test(handle.value)
      ? handle.value
      : null;
  } catch {
    return null;
  }
}
