import { describe, expect, it, vi } from "vitest";

import {
  createSchoolSettingsController,
  type SchoolSettingsController,
} from "../src/school-settings/school-settings-controller.js";
import type {
  StaffProductAccess,
  StaffProductAccessState,
  StaffProductAuthority,
  StaffProductRefreshResult,
} from "../src/auth/staff-product-access.js";

const authority: StaffProductAuthority = {
  accountId: "a1000000-0000-4000-8000-000000000001",
  profileId: "21000000-0000-4000-8000-000000000001",
  membershipId:
    "11000000-0000-4000-8000-000000000001:21000000-0000-4000-8000-000000000001",
  schoolId: "11000000-0000-4000-8000-000000000001",
  role: "owner",
  assuranceLevel: "aal2",
  identityGeneration: "identity-a",
  sessionGeneration: "session-a",
};
const handle = "synthetic-school-settings-handle";
function access(
  displayName = "Original School",
  settingsRevision = 4,
  identity = authority,
): StaffProductAccess {
  return {
    authority: { ...identity },
    school: { schoolId: identity.schoolId, displayName, settingsRevision },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function harness(initial = access()) {
  let live: StaffProductAccessState = { kind: "ready", access: initial };
  const refreshAccess = vi.fn(async (): Promise<StaffProductRefreshResult> =>
    live.kind === "ready"
      ? { kind: "fresh_authorized", access: live.access }
      : { kind: live.kind },
  );
  const capture = vi.fn(async (): Promise<unknown> => ({
    status: "ready",
    authorityHandle: handle,
  }));
  const update = vi.fn(
    async (request: {
      schoolId: string;
      displayName: string;
      expectedSettingsRevision: number;
    }): Promise<unknown> => {
      if (live.kind !== "ready")
        throw new Error("unexpected unavailable test authority");
      const unchanged = request.displayName === live.access.school.displayName;
      live = {
        kind: "ready",
        access: access(
          request.displayName,
          request.expectedSettingsRevision + (unchanged ? 0 : 1),
          live.access.authority,
        ),
      };
      return [
        {
          code: unchanged
            ? "school_display_name_unchanged"
            : "school_display_name_updated",
        },
      ];
    },
  );
  const release = vi.fn();
  const controller = createSchoolSettingsController({
    getAccess: () => live,
    refreshAccess,
    port: {
      captureSchoolSettingsAuthority: capture,
      updateSchoolDisplayName: update,
      releaseSchoolSettingsAuthority: release,
    },
  });
  return {
    controller,
    capture,
    update,
    release,
    refreshAccess,
    live: () => live,
    set(value: StaffProductAccessState) {
      live = value;
      controller.setAccess(value);
    },
    setLive(value: StaffProductAccessState) {
      live = value;
    },
  };
}
function save(controller: SchoolSettingsController) {
  return controller.dispatch({
    type: "save",
    snapshotRevision: controller.getSnapshot().revision,
  });
}
async function edit(
  controller: SchoolSettingsController,
  value = "New School",
) {
  await controller.dispatch({ type: "edit_name", value });
}

// Product state-machine tests use explicit boundary results, not database proof.
describe("School settings controller", () => {
  it.each(["owner", "administrator"] as const)(
    "%s Save captures immutable intent before the first await and needs no confirmation",
    async (role) => {
      const test = harness(
        access("Original School", 4, { ...authority, role }),
      );
      const preflight = deferred<StaffProductRefreshResult>();
      test.refreshAccess.mockImplementationOnce(() => preflight.promise);
      await edit(test.controller, "  New School  ");
      const pending = save(test.controller);
      expect(test.controller.getSnapshot()).toMatchObject({
        kind: "saving",
        phase: "verifying",
        draft: "New School",
      });
      await edit(test.controller, "Intruding later draft");
      expect(test.capture).not.toHaveBeenCalled();
      preflight.resolve({
        kind: "fresh_authorized",
        access: access("Original School", 4, { ...authority, role }),
      });
      expect(await pending).toMatchObject({
        kind: "editing",
        draft: "New School",
        school: { settingsRevision: 5, displayName: "New School" },
        notice: "updated",
      });
      expect(test.capture).toHaveBeenCalledExactlyOnceWith(authority.accountId);
      expect(test.update).toHaveBeenCalledExactlyOnceWith(
        {
          schoolId: authority.schoolId,
          displayName: "New School",
          expectedSettingsRevision: 4,
        },
        handle,
      );
      expect(test.release).toHaveBeenCalledExactlyOnceWith(handle);
      expect(test.refreshAccess).toHaveBeenCalledTimes(2);
      test.controller.dispose();
    },
  );

  it.each([
    { role: "teacher", assuranceLevel: "aal1" },
    { role: "owner", assuranceLevel: "aal1" },
  ] as const)(
    "never enables writes for $role at $assuranceLevel",
    async (changes) => {
      const test = harness(
        access("Original School", 4, { ...authority, ...changes }),
      );
      expect(test.controller.getSnapshot()).toMatchObject({
        kind: "read_only",
        school: { displayName: "Original School" },
      });
      await edit(test.controller);
      await save(test.controller);
      expect(test.refreshAccess).not.toHaveBeenCalled();
      expect(test.capture).not.toHaveBeenCalled();
      expect(test.update).not.toHaveBeenCalled();
      test.controller.dispose();
    },
  );

  it.each([
    ["   ", "required"],
    ["x".repeat(161), "too_long"],
    ["\tNew School", "invalid_characters"],
  ] as const)(
    "validates %s without refreshing or capturing",
    async (value, reason) => {
      const test = harness();
      await edit(test.controller, value);
      expect(await save(test.controller)).toMatchObject({
        kind: "editing",
        validation: reason,
      });
      expect(test.refreshAccess).not.toHaveBeenCalled();
      expect(test.capture).not.toHaveBeenCalled();
      test.controller.dispose();
    },
  );

  it("rejects an obsolete rendered Save and recognizes an acknowledged no-op", async () => {
    const test = harness();
    const oldRevision = test.controller.getSnapshot().revision;
    await edit(test.controller);
    await test.controller.dispatch({
      type: "save",
      snapshotRevision: oldRevision,
    });
    expect(test.refreshAccess).not.toHaveBeenCalled();
    await edit(test.controller, "Original School");
    expect(await save(test.controller)).toMatchObject({
      kind: "editing",
      notice: "unchanged",
      school: { settingsRevision: 4 },
    });
    test.controller.dispose();
  });

  it.each(["Different School", "New School"])(
    "a fresher revision with name %s never rebases a pending rename",
    async (name) => {
      const test = harness();
      await edit(test.controller);
      test.refreshAccess.mockImplementationOnce(async () => {
        const fresh = access(name, 5);
        test.set({ kind: "ready", access: fresh });
        return { kind: "fresh_authorized", access: fresh };
      });
      expect(await save(test.controller)).toMatchObject({
        kind: "conflict",
        draft: "New School",
        current: { displayName: name, settingsRevision: 5 },
      });
      expect(test.capture).not.toHaveBeenCalled();
      expect(test.update).not.toHaveBeenCalled();
      test.controller.dispose();
    },
  );

  it.each(["paused", "unavailable"] as const)(
    "a %s refresh never uses prior visible authorization",
    async (kind) => {
      const test = harness();
      await edit(test.controller);
      test.refreshAccess.mockResolvedValueOnce({ kind });
      expect(await save(test.controller)).toMatchObject({ kind });
      expect(test.capture).not.toHaveBeenCalled();
      test.set({ kind: "ready", access: access() });
      expect(test.controller.getSnapshot()).toMatchObject({
        kind: "editing",
        draft: kind === "paused" ? "New School" : "Original School",
      });
      test.controller.dispose();
    },
  );

  it("a fresh read for replacement B discards A's draft without capturing B", async () => {
    const test = harness();
    await edit(test.controller);
    const replacement = access("B School", 1, {
      ...authority,
      accountId: "a1000000-0000-4000-8000-000000000002",
      identityGeneration: "identity-b",
    });
    test.refreshAccess.mockImplementationOnce(async () => {
      test.setLive({ kind: "ready", access: replacement });
      return { kind: "fresh_authorized", access: replacement };
    });
    expect(await save(test.controller)).toMatchObject({
      kind: "editing",
      draft: "B School",
    });
    expect(test.capture).not.toHaveBeenCalled();
    expect(test.update).not.toHaveBeenCalled();
    test.controller.dispose();
  });

  it("a pause after joined preflight began invalidates its eventual fresh result", async () => {
    const test = harness();
    await edit(test.controller);
    const preflight = deferred<StaffProductRefreshResult>();
    test.refreshAccess.mockImplementationOnce(() => preflight.promise);
    const pending = save(test.controller);
    test.set({ kind: "paused", authority });
    preflight.resolve({ kind: "fresh_authorized", access: access() });
    expect(await pending).toMatchObject({ kind: "paused" });
    expect(test.capture).not.toHaveBeenCalled();
    test.set({ kind: "ready", access: access() });
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "editing",
      draft: "New School",
    });
    test.controller.dispose();
  });

  it.each([
    { status: "ended" },
    { status: "rejected" },
    { status: "unavailable" },
    { status: "ready", authorityHandle: handle, extra: "private" },
    { status: "ready", authorityHandle: "" },
    null,
  ])(
    "strictly rejects a capture failure or malformed envelope %#",
    async (captureResult) => {
      const test = harness();
      await edit(test.controller);
      test.capture.mockResolvedValueOnce(captureResult);
      expect(await save(test.controller)).toMatchObject({
        kind: "editing",
        notice: "rejected",
        draft: "New School",
      });
      expect(test.update).not.toHaveBeenCalled();
      expect(test.release).not.toHaveBeenCalled();
      test.controller.dispose();
    },
  );

  it.each(["switch", "pause", "dispose"] as const)(
    "releases a late capture without egress after %s",
    async (transition) => {
      const test = harness();
      await edit(test.controller);
      const captured = deferred<unknown>();
      test.capture.mockImplementationOnce(() => captured.promise);
      const pending = save(test.controller);
      await vi.waitFor(() => expect(test.capture).toHaveBeenCalledOnce());
      if (transition === "dispose") test.controller.dispose();
      else if (transition === "pause") test.set({ kind: "paused", authority });
      else
        test.setLive({
          kind: "ready",
          access: access("B School", 1, {
            ...authority,
            accountId: "a1000000-0000-4000-8000-000000000002",
            identityGeneration: "identity-b",
          }),
        });
      captured.resolve({ status: "ready", authorityHandle: handle });
      await pending;
      expect(test.update).not.toHaveBeenCalled();
      expect(test.release).toHaveBeenCalledExactlyOnceWith(handle);
      if (transition === "switch")
        expect(test.controller.getSnapshot()).toMatchObject({
          kind: "editing",
          draft: "B School",
        });
      test.controller.dispose();
    },
  );

  it("checks a presentation revision published synchronously immediately before egress", async () => {
    const test = harness();
    await edit(test.controller);
    test.controller.subscribe((snapshot) => {
      if (
        snapshot.kind === "saving" &&
        snapshot.phase === "submitting" &&
        snapshot.school.settingsRevision === 4
      )
        test.set({ kind: "ready", access: access("Concurrent School", 5) });
    });
    expect(await save(test.controller)).toMatchObject({
      kind: "conflict",
      draft: "New School",
      current: { settingsRevision: 5 },
    });
    expect(test.update).not.toHaveBeenCalled();
    expect(test.release).toHaveBeenCalledExactlyOnceWith(handle);
    test.controller.dispose();
  });

  it.each([
    "own publication",
    "concurrent newer revision",
    "lost response",
  ] as const)(
    "retains saving during %s published before the post-write refresh promise settles",
    async (scenario) => {
      const test = harness();
      await edit(test.controller);
      const published = deferred<void>();
      const finishRefresh = deferred<void>();
      test.refreshAccess.mockImplementationOnce(async () => ({
        kind: "fresh_authorized",
        access: access(),
      }));
      if (scenario === "lost response")
        test.update.mockImplementationOnce(async () => {
          throw new Error("private-diagnostic");
        });
      test.refreshAccess.mockImplementationOnce(async () => {
        const fresh =
          scenario === "concurrent newer revision"
            ? access("Concurrent School", 6)
            : access("New School", 5);
        test.set({ kind: "ready", access: fresh });
        published.resolve();
        await finishRefresh.promise;
        return { kind: "fresh_authorized", access: fresh };
      });
      const pending = save(test.controller);
      await published.promise;
      const during = test.controller.getSnapshot();
      expect(during).toMatchObject({
        kind: "saving",
        phase: "refreshing",
        draft: "New School",
        school: {
          settingsRevision: scenario === "concurrent newer revision" ? 6 : 5,
        },
      });
      await test.controller.dispatch({
        type: "keep_draft",
        snapshotRevision: during.revision,
      });
      await test.controller.dispatch({
        type: "save",
        snapshotRevision: during.revision,
      });
      await test.controller.dispatch({ type: "refresh" });
      expect(test.controller.getSnapshot()).toEqual(during);
      expect(test.update).toHaveBeenCalledOnce();
      expect(test.update.mock.calls[0]?.[0].expectedSettingsRevision).toBe(4);
      expect(test.refreshAccess).toHaveBeenCalledTimes(2);
      finishRefresh.resolve();
      const settled = await pending;
      expect(settled).toMatchObject(
        scenario === "own publication"
          ? { kind: "editing", draft: "New School", notice: "updated" }
          : {
              kind: "conflict",
              draft: "New School",
              notice: scenario === "lost response" ? "unconfirmed" : "updated",
            },
      );
      expect(test.release).toHaveBeenCalledExactlyOnceWith(handle);
      expect(JSON.stringify(settled)).not.toContain("private-diagnostic");
      test.controller.dispose();
    },
  );

  it("a paused submitted save stays unconfirmed after resume even when the old response acknowledges it", async () => {
    const test = harness();
    await edit(test.controller);
    const written = deferred<unknown>();
    test.update.mockImplementationOnce(() => written.promise);
    const pending = save(test.controller);
    await vi.waitFor(() => expect(test.update).toHaveBeenCalledOnce());
    test.set({ kind: "paused", authority });
    expect(test.controller.getSnapshot()).toMatchObject({ kind: "paused" });
    expect(test.release).toHaveBeenCalledExactlyOnceWith(handle);
    test.set({ kind: "ready", access: access("New School", 5) });
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "conflict",
      notice: "unconfirmed",
      draft: "New School",
    });
    written.resolve([{ code: "school_display_name_updated" }]);
    expect(await pending).toMatchObject({
      kind: "conflict",
      notice: "unconfirmed",
    });
    expect(test.refreshAccess).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledOnce();
    test.controller.dispose();
  });

  it("true authority loss discards a submitted draft and a late response cannot restore it", async () => {
    const test = harness();
    await edit(test.controller);
    const written = deferred<unknown>();
    test.update.mockImplementationOnce(() => written.promise);
    const pending = save(test.controller);
    await vi.waitFor(() => expect(test.update).toHaveBeenCalledOnce());
    test.set({ kind: "unavailable" });
    test.set({ kind: "ready", access: access() });
    written.resolve([{ code: "school_display_name_updated" }]);
    expect(await pending).toMatchObject({
      kind: "editing",
      draft: "Original School",
      notice: null,
    });
    expect(test.release).toHaveBeenCalledOnce();
    test.controller.dispose();
  });

  it("idle dirty conflicts require current rendered reconciliation and never silently adopt its revision", async () => {
    const test = harness();
    test.set({ kind: "ready", access: access("First Rename", 5) });
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "editing",
      draft: "First Rename",
    });
    await edit(test.controller, "My Draft");
    test.set({ kind: "ready", access: access("Second Rename", 6) });
    const stale = test.controller.getSnapshot().revision;
    test.set({ kind: "ready", access: access("Third Rename", 7) });
    await test.controller.dispatch({
      type: "keep_draft",
      snapshotRevision: stale,
    });
    await save(test.controller);
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "conflict",
      draft: "My Draft",
      current: { settingsRevision: 7 },
    });
    expect(test.capture).not.toHaveBeenCalled();
    await test.controller.dispatch({
      type: "keep_draft",
      snapshotRevision: test.controller.getSnapshot().revision,
    });
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "editing",
      draft: "My Draft",
      school: { settingsRevision: 7 },
    });
    await save(test.controller);
    expect(test.update).toHaveBeenCalledExactlyOnceWith(
      {
        schoolId: authority.schoolId,
        displayName: "My Draft",
        expectedSettingsRevision: 7,
      },
      handle,
    );
    test.controller.dispose();
  });

  it("use current name abandons the private draft without a mutation", async () => {
    const test = harness();
    await edit(test.controller);
    test.set({ kind: "ready", access: access("Concurrent School", 5) });
    await test.controller.dispatch({
      type: "use_current_name",
      snapshotRevision: test.controller.getSnapshot().revision,
    });
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "editing",
      draft: "Concurrent School",
      notice: null,
    });
    expect(test.update).not.toHaveBeenCalled();
    test.controller.dispose();
  });

  it("rejects equal-revision name contradictions, ignores lower presentation, and does not suppress changed authority", () => {
    const test = harness(access("Latest School", 8));
    test.set({ kind: "ready", access: access("Old School", 7) });
    expect(test.controller.getSnapshot()).toMatchObject({
      school: { displayName: "Latest School", settingsRevision: 8 },
    });
    test.set({
      kind: "ready",
      access: access("Teacher School", 1, {
        ...authority,
        role: "teacher",
        identityGeneration: "downgraded",
      }),
    });
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "read_only",
      school: { displayName: "Teacher School", settingsRevision: 1 },
    });
    test.set({
      kind: "ready",
      access: access("Contradiction", 1, {
        ...authority,
        role: "teacher",
        identityGeneration: "downgraded",
      }),
    });
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "unavailable",
    });
    test.controller.dispose();
  });

  it.each(["active", "lost"] as const)(
    "classifies a target denial using refreshed %s actor authority",
    async (actorState) => {
      const test = harness();
      await edit(test.controller);
      test.update.mockResolvedValueOnce([{ code: "forbidden" }]);
      if (actorState === "lost") {
        test.refreshAccess.mockImplementationOnce(async () => ({
          kind: "fresh_authorized",
          access: access(),
        }));
        test.refreshAccess.mockImplementationOnce(async () => {
          test.set({ kind: "unavailable" });
          return { kind: "unavailable" };
        });
      }
      expect(await save(test.controller)).toMatchObject(
        actorState === "active"
          ? { kind: "editing", notice: "rejected" }
          : { kind: "unavailable" },
      );
      test.controller.dispose();
    },
  );

  it("malformed or unavailable update outcomes cannot become success by refreshing a matching name", async () => {
    const test = harness();
    await edit(test.controller);
    test.update.mockImplementationOnce(async () => {
      test.setLive({ kind: "ready", access: access("New School", 5) });
      return [{ code: "school_display_name_updated", extra: "malformed" }];
    });
    expect(await save(test.controller)).toMatchObject({
      kind: "conflict",
      notice: "unconfirmed",
    });
    await test.controller.dispatch({ type: "refresh" });
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "conflict",
      notice: "unconfirmed",
    });
    expect(test.update).toHaveBeenCalledOnce();
    test.controller.dispose();
  });

  it("failed post-write refresh clears privileged presentation without claiming the current label", async () => {
    const test = harness();
    await edit(test.controller);
    test.refreshAccess.mockImplementationOnce(async () => ({
      kind: "fresh_authorized",
      access: access(),
    }));
    test.refreshAccess.mockRejectedValueOnce(
      new Error("private-refresh-diagnostic"),
    );
    expect(await save(test.controller)).toMatchObject({ kind: "unavailable" });
    expect(test.release).toHaveBeenCalledOnce();
    test.controller.dispose();
  });

  it("superseded explicit refresh completion cannot clear a newer verified presentation", async () => {
    const test = harness();
    const oldRefresh = deferred<StaffProductRefreshResult>();
    test.refreshAccess.mockImplementationOnce(() => oldRefresh.promise);
    const oldPending = test.controller.dispatch({ type: "refresh" });
    test.refreshAccess.mockImplementationOnce(async () => {
      const fresh = access("Latest School", 6);
      test.setLive({ kind: "ready", access: fresh });
      return { kind: "fresh_authorized", access: fresh };
    });
    await test.controller.dispatch({ type: "refresh" });
    oldRefresh.resolve({ kind: "unavailable" });
    expect(await oldPending).toMatchObject({
      kind: "editing",
      school: { displayName: "Latest School", settingsRevision: 6 },
    });
    test.controller.dispose();
  });

  it("a synchronous pause triggered by pending publication prevents even preflight from starting", async () => {
    const test = harness();
    await edit(test.controller);
    test.controller.subscribe((snapshot) => {
      if (snapshot.kind === "saving" && snapshot.phase === "verifying")
        test.set({ kind: "paused", authority });
    });
    expect(await save(test.controller)).toMatchObject({ kind: "paused" });
    expect(test.refreshAccess).not.toHaveBeenCalled();
    expect(test.capture).not.toHaveBeenCalled();
    test.controller.dispose();
  });
});
