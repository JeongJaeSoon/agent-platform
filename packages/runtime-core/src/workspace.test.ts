import { describe, expect, test } from "bun:test";
import {
  planWorkspacePreparation,
  sameRepository,
  type WorkspaceObservation,
  type WorkspacePlan,
} from "./workspace.ts";

const workspace = {
  repository: {
    id: "sample-app",
    url: "https://example.invalid/team/app.git",
    branch: "main",
  },
};
const checkpoint = {
  revision: 3,
  manifest_ref: "sessions/s/checkpoints/3/manifest.json",
  manifest_sha256: "a".repeat(64),
};
const sound: WorkspaceObservation = {
  kind: "checkout",
  remoteUrl: workspace.repository.url,
  branch: "main",
  healthy: true,
  localWork: false,
};

function plan(observed: WorkspaceObservation, restore = null) {
  return planWorkspacePreparation({ workspace, restore, observed });
}

describe("planWorkspacePreparation", () => {
  test("a committed checkpoint wins over whatever is on the volume", () => {
    expect(
      planWorkspacePreparation({
        workspace,
        restore: checkpoint,
        observed: sound,
      }),
    ).toEqual({ action: "restore", checkpoint });
  });

  describe("a session without a repository", () => {
    const local: WorkspaceObservation = {
      kind: "checkout",
      remoteUrl: "",
      branch: "main",
      healthy: true,
      // No origin reaches the empty commit: always "work" here.
      localWork: true,
      headCommit: true,
    };
    const planLocal = (observed: WorkspaceObservation, restore = null) =>
      planWorkspacePreparation({
        workspace: { repository: null },
        restore,
        observed,
      });

    test("restores a checkpoint before looking at the volume", () => {
      for (const observed of [
        { kind: "empty" } as const,
        { kind: "foreign" } as const,
        { ...local, healthy: false },
      ]) {
        expect(
          planWorkspacePreparation({
            workspace: { repository: null },
            restore: checkpoint,
            observed,
          }),
        ).toEqual({ action: "restore", checkpoint });
      }
    });

    test("initializes an empty root and keeps its own sound local git", () => {
      expect(planLocal({ kind: "empty" })).toEqual({ action: "init" });
      expect(planLocal(local)).toEqual({ action: "keep" });
    });

    test("refuses, never deletes, a partial init, an unsound git, an origin or stray files", () => {
      expect(planLocal({ ...local, headCommit: false })).toEqual({
        action: "refuse",
        reason: "local git has no commit: its init never finished",
      });
      const { headCommit: _unprobed, ...unprobed } = local;
      expect(planLocal(unprobed)).toMatchObject({ action: "refuse" });
      expect(planLocal({ ...local, healthy: false })).toEqual({
        action: "refuse",
        reason: "local git is incomplete or corrupt and exists nowhere else",
      });
      expect(
        planLocal({ ...local, localWork: false, healthy: false }),
      ).toMatchObject({
        action: "refuse",
      });
      expect(
        planLocal({ ...local, remoteUrl: workspace.repository.url }),
      ).toEqual({
        action: "refuse",
        reason: "checkout has an origin, but the session has no repository",
      });
      expect(planLocal({ kind: "foreign" })).toMatchObject({
        action: "refuse",
      });
      expect(planLocal({ kind: "interrupted" })).toMatchObject({
        action: "refuse",
      });
    });
  });

  test("an empty root is cloned from the descriptor", () => {
    expect(plan({ kind: "empty" })).toEqual({
      action: "clone",
      url: workspace.repository.url,
      branch: "main",
    });
  });

  test("a sound checkout of the same origin is reused, with local work or not, whatever the credentials or .git spelling", () => {
    const expected: WorkspacePlan = {
      action: "reuse",
      url: workspace.repository.url,
      branch: "main",
    };
    expect(
      plan({
        ...sound,
        remoteUrl: "https://token:x@EXAMPLE.invalid/team/app/",
        branch: "feature",
      }),
    ).toEqual(expected);
    expect(plan({ ...sound, localWork: true })).toEqual(expected);
  });

  test("this session's own unsound checkout is recreated only when nothing exists just here", () => {
    expect(plan({ ...sound, healthy: false })).toMatchObject({
      action: "recreate",
    });
    // Unpushed commits count as local work even with a clean tree.
    expect(plan({ ...sound, healthy: false, localWork: true })).toMatchObject({
      action: "refuse",
    });
  });

  test("a clone an earlier attempt never finished is recreated", () => {
    expect(plan({ kind: "interrupted" })).toEqual({
      action: "recreate",
      branch: "main",
      reason: "an earlier attempt's clone never finished",
      url: workspace.repository.url,
    });
  });

  test("another repository and foreign files are always refused, never deleted", () => {
    expect(
      plan({ ...sound, remoteUrl: "https://example.invalid/team/other.git" }),
    ).toMatchObject({ action: "refuse" });
    expect(plan({ kind: "foreign" })).toMatchObject({ action: "refuse" });
  });

  test("sameRepository handles scp-like URLs by text", () => {
    expect(
      sameRepository(
        "git@example.invalid:team/app.git",
        "git@example.invalid:team/app",
      ),
    ).toBe(true);
    expect(
      sameRepository(
        "git@example.invalid:team/app",
        "git@example.invalid:team/other",
      ),
    ).toBe(false);
  });
});
