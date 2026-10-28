import { describe, expect, test } from "bun:test";
import type { ProfileSummary } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { ceiling, imported, version } from "../test-support/profiles.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const CODING = imported("coding-claude");
const GENERAL = imported("general-read", {
  model: "claude-haiku-5",
  models: ["claude-haiku-5"],
  tools: [],
  permission_mode: "default",
  billing: "none",
  repository_mode: "none",
  repository_ids: [],
});

const rows = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .map((row) =>
      Array.from(
        row.querySelectorAll('[role="cell"], [role="columnheader"]'),
        (cell) => cell.textContent,
      ),
    );

function routes(items: ProfileSummary[], signedIn = me()) {
  return {
    "GET /v1/auth/me": () => json(200, signedIn),
    "GET /v1/profiles": () => json(200, { items }),
  };
}

const HEADER = [
  "이름",
  "버전",
  "종류",
  "바탕 프로필",
  "기본 모델",
  "권한 모드",
  "상태",
];

describe("실행 프로필", () => {
  test("lists ceilings and workspace profiles in one table from the sidebar", async () => {
    const { api } = renderAt(
      "/",
      routes([version(1, "usable"), CODING, GENERAL]),
    );
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
    // Ceilings first; each name cell ends in the line a phone shows instead
    // of the columns it drops.
    expect(rows(table)).toEqual([
      HEADER,
      [
        "coding-claudecoding-claude설치 상한 · v1",
        "v1",
        "설치 상한",
        "—",
        "claude-sonnet-5",
        "acceptEdits",
        "사용 가능",
      ],
      [
        "general-readgeneral-read설치 상한 · v1",
        "v1",
        "설치 상한",
        "—",
        "claude-haiku-5",
        "default",
        "사용 가능",
      ],
      [
        "strictws_acme_strict_v1워크스페이스 프로필 · v1",
        "v1",
        "워크스페이스 프로필",
        "coding-claude",
        "claude-sonnet-5",
        "default",
        "사용 가능",
      ],
    ]);
    // No cell truncates (GridTableCell `lines` cuts every line after the first).
    expect(table.querySelector("[data-lines], .truncate")).toBeNull();
    expect(screen.queryAllByText(/다시 배포|deploy again/).length).toBe(0);
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("an owner gets both ways to make one, each opening its own page", async () => {
    const { history } = renderAt("/profiles", routes([CODING]));
    const user = await setupUser();
    // The workspace one waits for a usable ceiling in the list.
    await screen.findByRole("link", { name: "프로필 만들기" });
    await user.click(screen.getByRole("link", { name: "설치 상한 만들기" }));
    await screen.findByRole("heading", { level: 1, name: "설치 상한 만들기" });
    expect(history.location.pathname).toBe("/profiles/new");
    expect(history.location.search).toContain("kind=installation");
  });

  test("an admin makes workspace profiles only", async () => {
    renderAt("/profiles", routes([CODING], me(undefined, "admin")));
    await screen.findByRole("link", { name: "프로필 만들기" });
    expect(
      screen.queryAllByRole("link", { name: "설치 상한 만들기" }).length,
    ).toBe(0);
  });

  test("a member reads every profile but gets no way to change them", async () => {
    renderAt("/profiles", routes([CODING, version(1, "usable")], memberMe()));
    await screen.findByRole("table", { name: "실행 프로필" });
    expect(
      screen.getByText("바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요"),
    ).toBeDefined();
    expect(screen.queryAllByRole("link", { name: /만들기/ }).length).toBe(0);
  });

  test("the kind filter narrows the table and counts each kind", async () => {
    renderAt("/profiles", routes([CODING, GENERAL, version(1, "usable")]));
    const table = await screen.findByRole("table", { name: "실행 프로필" });
    const filter = screen.getByRole("group", { name: "프로필 종류" });
    expect(
      within(filter)
        .getAllByRole("button")
        .map((button) => [
          button.textContent,
          button.getAttribute("aria-pressed"),
        ]),
    ).toEqual([
      ["전체 3", "true"],
      ["설치 상한 2", "false"],
      ["워크스페이스 프로필 1", "false"],
    ]);
    const user = await setupUser();
    await user.click(
      within(filter).getByRole("button", { name: /^워크스페이스 프로필/ }),
    );
    expect(
      rows(table)
        .slice(1)
        .map((row) => row[0]),
    ).toEqual(["strictws_acme_strict_v1워크스페이스 프로필 · v1"]);
    await user.click(
      within(filter).getByRole("button", { name: /^설치 상한/ }),
    );
    expect(
      rows(table)
        .slice(1)
        .map((row) => row[0]),
    ).toEqual([
      "coding-claudecoding-claude설치 상한 · v1",
      "general-readgeneral-read설치 상한 · v1",
    ]);
  });

  test("a name with several versions shows its latest, the earlier ones folded under it", async () => {
    renderAt(
      "/profiles",
      routes([
        ceiling("wide", 1, {}, { state: "retired" }),
        ceiling("wide", 2),
        version(1, "retired"),
        version(2, "usable"),
      ]),
    );
    const table = await screen.findByRole("table", { name: "실행 프로필" });
    expect(
      rows(table)
        .slice(1)
        .map((row) => [row[0], row[6]]),
    ).toEqual([
      ["wide 이전 버전 1개op_wide_v2설치 상한 · v2", "사용 가능"],
      [
        "strict 이전 버전 1개ws_acme_strict_v2워크스페이스 프로필 · v2",
        "사용 가능",
      ],
    ]);
    const user = await setupUser();
    const [first] = within(table).getAllByRole("button", {
      name: "이전 버전 1개",
    });
    expect(first?.getAttribute("aria-expanded")).toBe("false");
    await user.click(first as HTMLElement);
    expect(first?.getAttribute("aria-expanded")).toBe("true");
    expect(
      rows(table)
        .slice(1)
        .map((row) => [row[0], row[6]]),
    ).toEqual([
      ["wide 이전 버전 1개op_wide_v2설치 상한 · v2", "사용 가능"],
      ["wideop_wide_v1설치 상한 · v1", "사용 중지됨"],
      [
        "strict 이전 버전 1개ws_acme_strict_v2워크스페이스 프로필 · v2",
        "사용 가능",
      ],
    ]);
    await user.click(first as HTMLElement);
    expect(rows(table)).toHaveLength(3);
  });

  test("a ceiling folds under the version that names it as previous, not under a name it shares", async () => {
    renderAt(
      "/profiles",
      routes([
        // A catalog import whose id is a console ceiling's name, unlinked.
        imported("wide", {}, "retired"),
        ceiling("wide", 1),
        // The import's next version took a name of its own.
        ceiling("coding", 1, {}, { previous_id: "coding-claude" }),
        CODING,
      ]),
    );
    const table = await screen.findByRole("table", { name: "실행 프로필" });
    expect(
      rows(table)
        .slice(1)
        .map((row) => row[0]),
    ).toEqual([
      "coding 이전 버전 1개op_coding_v1설치 상한 · v1",
      "wideop_wide_v1설치 상한 · v1",
      "widewide설치 상한 · v1",
    ]);
  });

  test("every state a ceiling or a version can be in shows as its badge", async () => {
    renderAt(
      "/profiles",
      routes([
        imported("a-gone", {}, "connection_missing"),
        imported(
          "b-bypass",
          { permission_mode: "bypassPermissions" },
          "unattended_off",
        ),
        imported("c-drift", {}, "definition_drift"),
        imported("d-codex", {}, "runtime_unsupported"),
        imported("e-old", {}, "retired"),
        {
          ...version(1, "base_retired"),
          id: "ws_acme_x_v1",
          workspace: {
            ...(version(1, "base_retired").workspace as NonNullable<
              ProfileSummary["workspace"]
            >),
            name: "x",
            base_profile_id: "e-old",
          },
        },
        imported("f-stop", {}, "blocked"),
        {
          ...version(1, "base_blocked"),
          id: "ws_acme_y_v1",
          workspace: {
            ...(version(1, "base_blocked").workspace as NonNullable<
              ProfileSummary["workspace"]
            >),
            name: "y",
            base_profile_id: "f-stop",
          },
        },
      ]),
    );
    const table = await screen.findByRole("table", { name: "실행 프로필" });
    expect(
      Array.from(table.querySelectorAll("[data-slot=badge]"), (badge) => [
        badge.textContent,
        badge.className.match(/--ap-tone-(\w+)-bg/)?.[1],
      ]),
    ).toEqual([
      ["연결 없음", "danger"],
      ["이 설치에서 꺼짐", "danger"],
      ["설정이 바뀜", "danger"],
      ["지원하지 않는 런타임", "danger"],
      ["사용 중지됨", "neutral"],
      ["차단됨", "danger"],
      ["바탕 프로필 사용 중지됨", "neutral"],
      ["바탕 프로필 차단됨", "danger"],
    ]);
  });

  test("a version whose base changed or is gone warns above the table", async () => {
    renderAt(
      "/profiles",
      routes([
        CODING,
        version(1, "base_changed"),
        {
          ...version(1, "base_missing", {}, "removed-profile"),
          id: "ws_acme_gone_v1",
          workspace: {
            ...(version(1, "base_missing", {}, "removed-profile")
              .workspace as NonNullable<ProfileSummary["workspace"]>),
            name: "gone",
          },
        },
      ]),
    );
    expect(
      await screen.findByText("strict의 바탕 프로필이 바뀌었습니다"),
    ).toBeDefined();
    expect(screen.getByText("gone의 바탕 프로필이 없어졌습니다")).toBeDefined();
  });

  test("a failed read says so and asks again", async () => {
    let failing = true;
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () =>
        failing
          ? apiError(500, "INTERNAL", "boom")
          : json(200, { items: [CODING] }),
    });
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    failing = false;
    retry.click();
    await screen.findByRole("table", { name: "실행 프로필" });
  });

  test("an installation without profiles says so; with no usable ceiling there is nothing to narrow", async () => {
    renderAt("/profiles", routes([]));
    await screen.findByText("이 설치에 실행 프로필이 없습니다.");
    expect(screen.queryAllByRole("table", { name: "실행 프로필" }).length).toBe(
      0,
    );
    expect(
      screen.queryAllByRole("link", { name: "프로필 만들기" }).length,
    ).toBe(0);
    // An owner can still make the first ceiling.
    expect(
      screen.getByRole("link", { name: "설치 상한 만들기" }),
    ).toBeDefined();
  });

  test("a ceiling that runs nowhere here is no base to make a profile from", async () => {
    renderAt(
      "/profiles",
      routes([imported("coding-claude", {}, "connection_missing")]),
    );
    await screen.findByRole("table", { name: "실행 프로필" });
    await waitFor(() =>
      expect(
        screen.queryAllByRole("link", { name: "프로필 만들기" }).length,
      ).toBe(0),
    );
  });
});
