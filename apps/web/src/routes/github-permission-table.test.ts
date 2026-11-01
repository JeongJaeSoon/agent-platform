import { describe, expect, test } from "bun:test";
import type { GitHubCeiling } from "@werft-ai/contracts";
import {
  appStatusOf,
  approvalOf,
  lackingOf,
  needOf,
  permissionTable,
} from "./github-permission-table.ts";

const OFF: GitHubCeiling = {
  workflows: false,
  actions: false,
  checks: false,
  issues: false,
  review: false,
};

describe("needOf", () => {
  test("작성용은 기본 셋에 켠 기능만 더하고, 화면에 없는 검사·이슈는 넣지 않는다", () => {
    expect(needOf("author", { ...OFF, checks: true, issues: true })).toEqual({
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    });
    expect(needOf("author", { ...OFF, actions: true, workflows: true })).toEqual(
      {
        contents: "write",
        pull_requests: "write",
        metadata: "read",
        actions: "write",
        workflows: "write",
      },
    );
  });

  test("리뷰 승인용은 리뷰를 켤 때만 필요하다", () => {
    expect(needOf("reviewer", OFF)).toEqual({});
    expect(needOf("reviewer", { ...OFF, review: true })).toEqual({
      contents: "read",
      pull_requests: "write",
    });
  });
});

describe("appStatusOf", () => {
  test("모자람이 먼저, 안내 밖은 red, 안내 안의 쓰지 않는 권한은 현재 필요 없음", () => {
    expect(appStatusOf("author", "workflows", "write", null)).toBe("missing");
    expect(appStatusOf("author", "contents", "write", "read")).toBe("short");
    expect(appStatusOf("author", "administration", null, "write")).toBe(
      "beyond",
    );
    expect(appStatusOf("reviewer", "contents", "read", "write")).toBe("beyond");
    expect(appStatusOf("author", "issues", null, "write")).toBe("unused");
    expect(appStatusOf("author", "actions", "write", "write")).toBe("ok");
    expect(appStatusOf("author", "metadata", "read", "read")).toBe("ok");
  });
});

describe("approvalOf", () => {
  test("승인 권한을 못 읽었거나 설치가 없으면 unknown이지 대기가 아니다", () => {
    expect(approvalOf("write", null, "contents")).toBe("unknown");
    expect(approvalOf("write", undefined, "contents")).toBe("unknown");
  });

  test("설치가 App 수준 이상을 승인했을 때만 approved", () => {
    expect(approvalOf("write", { contents: "write" }, "contents")).toBe(
      "approved",
    );
    expect(approvalOf("write", { contents: "read" }, "contents")).toBe(
      "pending",
    );
    expect(approvalOf("write", {}, "contents")).toBe("pending");
    // The App does not hold it: nothing to approve.
    expect(approvalOf(null, {}, "workflows")).toBe("approved");
  });
});

describe("permissionTable", () => {
  const app = {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
    actions: "write",
    issues: "write",
  } as const;

  test("행은 고정 순서이고 토글로 상태가 바뀌어도 움직이지 않는다", () => {
    const saved = { ...OFF, actions: true };
    const before = permissionTable({
      role: "author",
      app,
      approved: app,
      ceiling: saved,
      saved,
    });
    const after = permissionTable({
      role: "author",
      app,
      approved: app,
      ceiling: { ...saved, workflows: true },
      saved,
    });
    expect(before.rows.map((row) => row.name)).toEqual([
      "contents",
      "pull_requests",
      "metadata",
      "actions",
      "issues",
    ]);
    expect(after.rows.map((row) => row.name)).toEqual([
      "contents",
      "pull_requests",
      "metadata",
      "actions",
      "workflows",
      "issues",
    ]);
    const workflows = after.rows.find((row) => row.name === "workflows");
    expect(workflows).toMatchObject({
      need: "write",
      app: null,
      status: "missing",
      badge: "missing",
      changed: true,
    });
    expect(after.changed.map((row) => row.name)).toEqual(["workflows"]);
    expect(before.changed).toEqual([]);
  });

  test("모르는 권한은 고정 순서 뒤에 이름순으로 붙는다", () => {
    const { rows } = permissionTable({
      role: "author",
      app: { zeta: "read", administration: "write", alpha: "read" },
      approved: null,
      ceiling: OFF,
      saved: OFF,
    });
    expect(rows.map((row) => row.name)).toEqual([
      "contents",
      "pull_requests",
      "metadata",
      "administration",
      "alpha",
      "zeta",
    ]);
  });

  test("안내보다 넓음과 승인 대기는 배지와 설치 칸으로 함께 보인다", () => {
    const { rows } = permissionTable({
      role: "author",
      app: { ...app, administration: "write" },
      approved: { contents: "write" },
      ceiling: OFF,
      saved: OFF,
    });
    const admin = rows.find((row) => row.name === "administration");
    expect(admin).toMatchObject({
      status: "beyond",
      approval: "pending",
      badge: "beyond",
      granted: null,
    });
    const issues = rows.find((row) => row.name === "issues");
    expect(issues).toMatchObject({
      status: "unused",
      approval: "pending",
      badge: "pending",
    });
    const contents = rows.find((row) => row.name === "contents");
    expect(contents).toMatchObject({ status: "ok", approval: "approved" });
  });

  test("승인 미확인은 승인 대기 배지를 그리지 않는다", () => {
    const { rows, pending } = permissionTable({
      role: "author",
      app,
      approved: null,
      ceiling: OFF,
      saved: OFF,
    });
    expect(rows.every((row) => row.approval === "unknown")).toBe(true);
    expect(rows.some((row) => row.badge === "pending")).toBe(false);
    expect(pending).toBe(false);
  });

  test("설치가 App 권한 하나라도 덜 승인했으면 pending", () => {
    expect(
      permissionTable({
        role: "author",
        app,
        approved: { ...app, actions: "read" },
        ceiling: OFF,
        saved: OFF,
      }).pending,
    ).toBe(true);
    expect(
      permissionTable({
        role: "author",
        app,
        approved: app,
        ceiling: OFF,
        saved: OFF,
      }).pending,
    ).toBe(false);
  });
});

describe("lackingOf", () => {
  test("켠 기능에 App 권한이 모자란 것만, 필요 순서대로", () => {
    expect(
      lackingOf(
        "author",
        { contents: "read", pull_requests: "write", metadata: "read" },
        { ...OFF, workflows: true },
      ),
    ).toEqual([
      ["contents", "write"],
      ["workflows", "write"],
    ]);
    expect(lackingOf("reviewer", {}, OFF)).toEqual([]);
  });
});
