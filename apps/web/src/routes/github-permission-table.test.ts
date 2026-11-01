import { describe, expect, test } from "bun:test";
import {
  authorNeed,
  firstShortfall,
  ownerOf,
  permissionRows,
  statusOf,
} from "./github-permission-table.ts";

const OFF = {
  workflows: false,
  actions: false,
  checks: false,
  issues: false,
  review: false,
};

describe("GitHub 권한 표 판정", () => {
  test("상태는 필요와 App 수준을 비교해 정한다", () => {
    expect(statusOf("write", null)).toBe("missing");
    expect(statusOf("write", "read")).toBe("short");
    expect(statusOf(null, "read")).toBe("wide");
    expect(statusOf("read", "write")).toBe("wide");
    expect(statusOf("write", "write")).toBe("ok");
    expect(statusOf(null, null)).toBe("ok");
  });

  test("필요는 켠 기능만 더하고, 꺼 둔 검사·이슈는 필요에 넣지 않는다", () => {
    expect(authorNeed({ ...OFF, checks: true, issues: true })).toEqual({
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    });
    expect(authorNeed({ ...OFF, actions: true, workflows: true })).toEqual({
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      actions: "write",
      workflows: "write",
    });
  });

  test("없음·부족·넓음·맞음 순으로, 같은 상태 안에서는 기본 권한 순으로 놓는다", () => {
    const rows = permissionRows(
      {
        metadata: "read",
        pull_requests: "write",
        contents: "read",
        issues: "write",
        actions: "read",
      },
      { ...OFF, actions: true, workflows: true },
    );
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["workflows", "missing"],
      ["contents", "short"],
      ["actions", "short"],
      ["issues", "wide"],
      ["pull_requests", "ok"],
      ["metadata", "ok"],
    ]);
    expect(rows.find((row) => row.name === "issues")?.feature).toBeNull();
    expect(rows.find((row) => row.name === "contents")?.feature).toBe("base");
  });

  test("기능에 모자란 첫 권한을 짚고, App 권한을 아직 못 읽었으면 판단하지 않는다", () => {
    expect(firstShortfall({ actions: "write" }, { actions: "read" })).toEqual({
      name: "actions",
      held: "read",
    });
    expect(firstShortfall({ workflows: "write" }, {})).toEqual({
      name: "workflows",
      held: null,
    });
    expect(firstShortfall({ actions: "write" }, { actions: "admin" })).toBe(
      null,
    );
    expect(firstShortfall({ actions: "write" }, null)).toBe(null);
  });

  test("clone URL에서 계정을 읽는다", () => {
    expect(ownerOf("https://github.com/acme/api.git")).toBe("acme");
    expect(ownerOf("not a url")).toBe(null);
  });
});
