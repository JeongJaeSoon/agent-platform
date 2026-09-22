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
  dirty: false,
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

  test("an empty root is cloned from the descriptor", () => {
    expect(plan({ kind: "empty" })).toEqual({
      action: "clone",
      url: workspace.repository.url,
      branch: "main",
    });
  });

  test("a sound checkout of the same origin is reused, dirty or not, whatever the credentials or .git spelling", () => {
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
    expect(plan({ ...sound, dirty: true })).toEqual(expected);
  });

  test("this session's own unsound leftovers are recreated, unless they carry changes", () => {
    expect(plan({ ...sound, healthy: false })).toMatchObject({
      action: "recreate",
      reason: "checkout is incomplete or corrupt",
    });
    expect(plan({ ...sound, healthy: false, dirty: true })).toMatchObject({
      action: "refuse",
    });
  });

  test("another repository is recreated only when clean; foreign files are always refused", () => {
    const other = {
      ...sound,
      remoteUrl: "https://example.invalid/team/other.git",
    };
    expect(plan(other)).toMatchObject({
      action: "recreate",
      reason: "checkout belongs to another repository",
    });
    expect(plan({ ...other, dirty: true })).toMatchObject({
      action: "refuse",
    });
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
