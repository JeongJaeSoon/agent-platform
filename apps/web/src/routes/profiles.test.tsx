import { describe, expect, test } from "bun:test";
import type { ProfileSummary } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const PROFILES: ProfileSummary[] = [
  {
    id: "coding-claude",
    model: "claude-sonnet-5",
    tools: ["Read", "Edit", "Bash"],
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    billing: "metered",
    repository_mode: "required",
  },
  {
    id: "general-read",
    model: "claude-haiku-5",
    tools: [],
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    billing: "none",
    repository_mode: "none",
  },
];

const rows = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .map((row) =>
      Array.from(
        row.querySelectorAll('[role="cell"], [role="columnheader"]'),
        (cell) => cell.textContent,
      ),
    );

describe("실행 프로필", () => {
  test("lists the catalog's profiles from the sidebar, read only", async () => {
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () => json(200, { items: PROFILES }),
    });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    const user = await setupUser();
    await user.click(
      await within(nav).findByRole("link", { name: "실행 프로필" }),
    );
    await screen.findByRole("heading", { level: 1, name: "실행 프로필" });
    expect(
      within(nav)
        .getByRole("link", { name: "실행 프로필" })
        .getAttribute("aria-current"),
    ).toBe("page");
    const table = await screen.findByRole("table", { name: "실행 프로필" });
    // Every value stays in its row at any width; nothing hides narrow.
    expect(rows(table)).toEqual([
      ["프로필", "모델", "실행 환경"],
      [
        "coding-claudeClaude Agent SDK 0.3.270",
        "claude-sonnet-5비용 집계",
        "저장소 필요Read, Edit, Bash",
      ],
      [
        "general-readClaude Agent SDK 0.3.270",
        "claude-haiku-5비용 집계 안 함",
        "저장소 쓰지 않음도구 없음",
      ],
    ]);
    // DOM tests cannot see CSS clipping: no cell hides narrow or truncates
    // (GridTableCell `lines` truncates every line after the first).
    expect(
      table.querySelector("[data-hide-narrow], [data-lines], .truncate"),
    ).toBeNull();
    expect(screen.getByText("프로필 2개")).toBeDefined();
    expect(
      screen.getByText(
        "프로필은 설치 설정에서 정의합니다. 콘솔에서는 읽기만 합니다",
      ),
    ).toBeDefined();
    // Nothing on the screen writes.
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("a member reads the profiles they may pick", async () => {
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/profiles": () => json(200, { items: PROFILES }),
    });
    await screen.findByRole("table", { name: "실행 프로필" });
    expect(screen.getByText("내가 고를 수 있는 프로필입니다")).toBeDefined();
  });

  test("a failed read says so and asks again", async () => {
    let failing = true;
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () =>
        failing
          ? apiError(500, "INTERNAL", "boom")
          : json(200, { items: PROFILES }),
    });
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    failing = false;
    retry.click();
    await screen.findByRole("table", { name: "실행 프로필" });
  });

  test("an installation without profiles says so", async () => {
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () => json(200, { items: [] }),
    });
    await screen.findByText("이 설치에 실행 프로필이 없습니다.");
    await waitFor(() =>
      expect(screen.queryByRole("table", { name: "실행 프로필" })).toBeNull(),
    );
  });
});
