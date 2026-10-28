import { describe, expect, test } from "bun:test";
import type {
  CreateInstallationProfileRequest,
  CreateWorkspaceProfileRequest,
  InstallationProfileOptionsResponse,
  ProfileSummary,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { json, me, memberMe } from "../test-support/fake-api.ts";
import {
  ceiling,
  imported,
  OPTIONS,
  RECEIPT_ID,
  refusal,
  version,
} from "../test-support/profiles.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

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

function catalog(
  start: ProfileSummary[] = [CODING, GENERAL],
  signedIn = me(),
  options: InstallationProfileOptionsResponse = OPTIONS,
) {
  const items = [...start];
  return {
    items,
    routes: {
      "GET /v1/auth/me": () => json(200, signedIn),
      "GET /v1/profiles": () => json(200, { items }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/installation-profiles/options": () => json(200, options),
      "POST /v1/workspace-profiles": async (request: Request) => {
        const { name, base_profile_id, ...narrowed } =
          (await request.json()) as CreateWorkspaceProfileRequest;
        const n =
          items.filter((item) => item.workspace?.name === name).length + 1;
        const made: ProfileSummary = {
          ...version(n, "usable", narrowed, base_profile_id),
          id: `ws_acme_${name}_v${n}`,
        };
        made.workspace = {
          ...(made.workspace as NonNullable<ProfileSummary["workspace"]>),
          name,
        };
        items.push(made);
        return json(201, { profile: made, receipt_id: RECEIPT_ID });
      },
      "POST /v1/installation-profiles": async (request: Request) => {
        const body = (await request.json()) as CreateInstallationProfileRequest;
        const n =
          items.filter((item) => item.installation?.name === body.name).length +
          1;
        const made = ceiling(
          body.name,
          n,
          {
            model: body.model,
            models: body.models,
            tools: body.tools,
            permission_mode: body.permission_mode,
            repository_ids: body.repository_ids,
          },
          { previous_id: body.previous_id ?? null },
        );
        items.push(made);
        return json(201, { profile: made, receipt_id: RECEIPT_ID });
      },
    },
  };
}

const posted = (api: { calls: { method: string; body?: unknown }[] }) =>
  api.calls.filter((call) => call.method === "POST").map((call) => call.body);

const form = () =>
  screen.getByRole("main").querySelector("form") as HTMLElement;

describe("프로필 만들기 (워크스페이스)", () => {
  test("an owner narrows a ceiling and lands on the new version", async () => {
    const server = catalog();
    const { api, history } = renderAt(
      "/profiles/new?kind=workspace",
      server.routes,
    );
    await screen.findByRole("heading", { level: 1, name: "프로필 만들기" });
    const base = (await screen.findByLabelText(
      "바탕 프로필",
    )) as HTMLSelectElement;
    expect(base.value).toBe("coding-claude");
    expect(
      within(form())
        .getAllByRole("checkbox")
        .map((box) => [
          box.closest("[data-slot=field]")?.textContent,
          box.getAttribute("aria-checked"),
        ]),
    ).toEqual([
      ["claude-sonnet-5", "true"],
      ["claude-haiku-5", "false"],
      ["Read", "true"],
      ["Edit", "true"],
      ["Bash", "true"],
    ]);
    const mode = screen.getByLabelText("권한 모드") as HTMLSelectElement;
    expect(
      [...mode.options].map((option) => [option.value, option.disabled]),
    ).toEqual([
      ["acceptEdits", false],
      ["default", false],
      ["plan", false],
      ["auto", true],
      ["bypassPermissions", true],
    ]);
    const review = screen.getByRole("group", { name: "검토" });
    const changes = () =>
      Array.from(review.querySelectorAll("dt"), (term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]);
    // A new profile starts on the base's default model alone.
    expect(changes()).toEqual([
      ["모델", "claude-sonnet-5, claude-haiku-5 → claude-sonnet-5"],
    ]);

    const user = await setupUser();
    await user.type(screen.getByLabelText("이름"), "strict");
    expect(
      screen.getByText("저장할 버전의 id: ws_acme_strict_v1"),
    ).toBeDefined();
    await user.click(screen.getByRole("checkbox", { name: "Bash" }));
    await user.selectOptions(mode, "plan");
    // The review lists only what changed.
    expect(changes()).toEqual([
      ["모델", "claude-sonnet-5, claude-haiku-5 → claude-sonnet-5"],
      ["도구", "Read, Edit, Bash → Read, Edit"],
      ["권한 모드", "acceptEdits → plan"],
    ]);
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));

    await waitFor(() =>
      expect(history.location.pathname).toBe("/profiles/ws_acme_strict_v1"),
    );
    expect(posted(api)).toEqual([
      {
        name: "strict",
        base_profile_id: "coding-claude",
        model: "claude-sonnet-5",
        models: ["claude-sonnet-5"],
        tools: ["Read", "Edit"],
        permission_mode: "plan",
      },
    ]);
  });

  test("an admin has no kind to pick and gets the workspace form even when asking for a ceiling", async () => {
    const { api } = renderAt(
      "/profiles/new?kind=installation",
      catalog(undefined, me(undefined, "admin")).routes,
    );
    await screen.findByLabelText("바탕 프로필");
    expect(screen.queryAllByRole("radiogroup").length).toBe(0);
    expect(screen.queryAllByLabelText("연결").length).toBe(0);
    // It never asks for what only an owner may read.
    expect(
      api.calls.some((call) =>
        call.path.startsWith("/v1/installation-profiles"),
      ),
    ).toBe(false);
  });

  test("a member is told why there is no form", async () => {
    renderAt("/profiles/new", catalog(undefined, memberMe()).routes);
    await screen.findByText(/워크스페이스 설정 변경/);
    expect(screen.getByRole("main").querySelector("form")).toBeNull();
  });

  test("a new profile starts on a base that allows auto, at auto, and may pick bypassPermissions over a bypass base", async () => {
    const operator = (id: string, mode: "auto" | "bypassPermissions") =>
      imported(id, { permission_mode: mode });
    const server = catalog([
      CODING,
      GENERAL,
      operator("coding-auto", "auto"),
      operator("coding-bypass", "bypassPermissions"),
    ]);
    const { api } = renderAt("/profiles/new?kind=workspace", server.routes);
    const base = (await screen.findByLabelText(
      "바탕 프로필",
    )) as HTMLSelectElement;
    expect(base.value).toBe("coding-auto");
    const mode = screen.getByLabelText("권한 모드") as HTMLSelectElement;
    expect(mode.value).toBe("auto");
    const user = await setupUser();
    await user.selectOptions(base, "coding-bypass");
    const risk = /^bypassPermissions는 모든 도구 호출을 아무 판정 없이/;
    expect(screen.queryAllByText(risk).length).toBe(0);
    await user.type(screen.getByLabelText("이름"), "free");
    await user.selectOptions(mode, "bypassPermissions");
    const warning = screen.getByText(risk).closest("[data-slot=alert]");
    expect(mode.getAttribute("aria-describedby")?.split(" ")).toContain(
      warning?.id,
    );
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect(posted(api)[0]).toMatchObject({
      base_profile_id: "coding-bypass",
      permission_mode: "bypassPermissions",
    });
  });

  test("from=<ceiling> starts on that ceiling", async () => {
    renderAt(
      "/profiles/new?kind=workspace&from=general-read",
      catalog().routes,
    );
    const base = (await screen.findByLabelText(
      "바탕 프로필",
    )) as HTMLSelectElement;
    expect(base.value).toBe("general-read");
  });

  test("mode=version starts from the version it follows and keeps its name", async () => {
    const server = catalog([
      CODING,
      version(1, "usable", {
        tools: ["Read", "Edit"],
        permission_mode: "plan",
      }),
    ]);
    const { api } = renderAt(
      "/profiles/new?kind=workspace&from=ws_acme_strict_v1&mode=version",
      server.routes,
    );
    await screen.findByRole("heading", { level: 1, name: "strict 새 버전" });
    expect(screen.queryAllByRole("radiogroup").length).toBe(0);
    expect(screen.queryAllByLabelText("바탕 프로필").length).toBe(0);
    expect((screen.getByLabelText("이름") as HTMLInputElement).readOnly).toBe(
      true,
    );
    expect(
      screen.getByText("저장할 버전의 id: ws_acme_strict_v2"),
    ).toBeDefined();
    const user = await setupUser();
    await user.click(screen.getByRole("checkbox", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect(posted(api)).toEqual([
      {
        name: "strict",
        base_profile_id: "coding-claude",
        model: "claude-sonnet-5",
        models: ["claude-sonnet-5"],
        tools: ["Read"],
        permission_mode: "plan",
      },
    ]);
  });

  test("mode=remake is titled as such", async () => {
    renderAt(
      "/profiles/new?kind=workspace&from=ws_acme_strict_v1&mode=remake",
      catalog([CODING, version(1, "base_changed")]).routes,
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "strict 다시 만들기",
      }),
    ).toBeDefined();
  });

  test("a version over a ceiling that does not run here cannot be continued", async () => {
    renderAt(
      "/profiles/new?kind=workspace&from=ws_acme_strict_v1&mode=version",
      catalog([imported("coding-claude", {}, "retired"), version(1, "usable")])
        .routes,
    );
    expect(await screen.findByText("지금은 만들 수 없습니다")).toBeDefined();
  });

  test("a name the server would refuse, too many tools or too long a name are caught before the request", async () => {
    const wide = imported("coding-claude", {
      tools: Array.from({ length: 65 }, (_, n) => `Tool${n}`),
    });
    const { api } = renderAt("/profiles/new", catalog([wide]).routes);
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "Strict Review");
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    expect(
      await screen.findByText(
        "이름은 영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
      ),
    ).toBeDefined();
    await user.clear(screen.getByLabelText("이름"));
    await user.type(screen.getByLabelText("이름"), "wide");
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    expect(
      await screen.findByText(
        "한 프로필에는 모델 32개, 도구 64개까지 담습니다. 줄인 뒤 다시 저장하세요.",
      ),
    ).toBeDefined();
    expect(posted(api)).toEqual([]);
  });

  test("a save the base no longer allows, or over a base retired meanwhile, says so", async () => {
    let details: Record<string, unknown> = {
      reason_code: "widens_base",
      field: "tools",
    };
    renderAt("/profiles/new", {
      ...catalog().routes,
      "POST /v1/workspace-profiles": () => refusal(400, "BAD_REQUEST", details),
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "strict");
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    expect(
      await screen.findByText(
        "바탕 프로필이 허용하지 않는 값입니다. 목록을 다시 불러와 바탕 프로필을 확인하세요.",
      ),
    ).toBeDefined();
    details = { reason_code: "retired", field: "base_profile_id" };
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    expect(
      await screen.findByText(
        "그 바탕 프로필은 지금 쓸 수 없습니다. 사용할 수 있는 바탕 프로필을 고르세요.",
      ),
    ).toBeDefined();
  });

  test("a base the list read again as retired is refused before the request", async () => {
    const server = catalog();
    const { api, services } = renderAt("/profiles/new", server.routes);
    const base = (await screen.findByLabelText(
      "바탕 프로필",
    )) as HTMLSelectElement;
    server.items[0] = imported("coding-claude", {}, "retired");
    await act(() => services.queryClient.invalidateQueries());
    await waitFor(() =>
      expect(
        Array.from(base.options).find(
          (option) => option.value === "coding-claude",
        )?.disabled,
      ).toBe(true),
    );
    const user = await setupUser();
    await user.type(screen.getByLabelText("이름"), "strict");
    await user.click(screen.getByRole("button", { name: "새 버전으로 저장" }));
    expect(
      await screen.findByText(
        "그 바탕 프로필은 지금 쓸 수 없습니다. 사용할 수 있는 바탕 프로필을 고르세요.",
      ),
    ).toBeDefined();
    expect(posted(api)).toEqual([]);
  });
});

describe("프로필 만들기 (설치 상한)", () => {
  test("an owner picks the kind, and the ceiling form reads its choices from options", async () => {
    const { history } = renderAt("/profiles/new", catalog().routes);
    const kinds = await screen.findByRole("radiogroup", { name: "종류" });
    expect(
      within(kinds)
        .getAllByRole("radio")
        .map((radio) => [
          radio.closest("[data-slot=field]")?.querySelector("label")
            ?.textContent,
          radio.getAttribute("aria-checked"),
        ]),
    ).toEqual([
      ["워크스페이스 프로필", "true"],
      ["설치 상한", "false"],
    ]);
    const user = await setupUser();
    await user.click(within(kinds).getByRole("radio", { name: "설치 상한" }));
    await waitFor(() =>
      expect(history.location.search).toContain("kind=installation"),
    );
    const connection = (await screen.findByLabelText(
      "연결",
    )) as HTMLSelectElement;
    expect(
      Array.from(connection.options, (option) => option.textContent),
    ).toEqual([
      "anthropic (anthropic · 비용 집계)",
      "local (litellm · 비용 집계 안 함)",
    ]);
    expect(
      Array.from(
        (screen.getByLabelText("런타임") as HTMLSelectElement).options,
        (option) => option.value,
      ),
    ).toEqual(["claude_agent_sdk"]);
    // A new ceiling takes the runtime version the installation already runs.
    expect(
      (screen.getByLabelText("런타임 버전") as HTMLInputElement).value,
    ).toBe("0.3.270");
    expect(
      Array.from(
        within(form()).getAllByRole("checkbox"),
        (box) =>
          box.closest("[data-slot=field]")?.querySelector("label")?.textContent,
      ),
    ).toEqual(["저장소의 CLAUDE.md 읽기", "docs", "platform"]);
  });

  test("with the unattended switch off, bypassPermissions is listed closed with its reason; on, it warns", async () => {
    renderAt("/profiles/new?kind=installation", catalog().routes);
    const mode = (await screen.findByLabelText(
      "권한 모드",
    )) as HTMLSelectElement;
    expect(
      [...mode.options].map((option) => [option.value, option.disabled]),
    ).toEqual([
      ["default", false],
      ["acceptEdits", false],
      ["plan", false],
      ["auto", false],
      ["bypassPermissions", true],
    ]);
    expect(
      screen.getByText(
        "이 설치는 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS가 꺼져 있어 bypassPermissions를 고를 수 없습니다.",
      ),
    ).toBeDefined();
  });

  test("with the unattended switch on, bypassPermissions may be picked and warns", async () => {
    renderAt(
      "/profiles/new?kind=installation",
      catalog(undefined, me(), { ...OPTIONS, unattended_allowed: true }).routes,
    );
    const mode = (await screen.findByLabelText(
      "권한 모드",
    )) as HTMLSelectElement;
    expect(
      [...mode.options].find((option) => option.value === "bypassPermissions")
        ?.disabled,
    ).toBe(false);
    expect(screen.queryAllByText(/를 고를 수 없습니다\.$/).length).toBe(0);
    const user = await setupUser();
    await user.selectOptions(mode, "bypassPermissions");
    const warning = screen
      .getByText(/^bypassPermissions는 모든 도구 호출을 아무 판정 없이/)
      .closest("[data-slot=alert]");
    expect(mode.getAttribute("aria-describedby")?.split(" ")).toContain(
      warning?.id,
    );
  });

  test("an owner saves a first version and lands on it", async () => {
    const { api, history } = renderAt(
      "/profiles/new?kind=installation",
      catalog().routes,
    );
    await screen.findByRole("heading", { level: 1, name: "설치 상한 만들기" });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "wide");
    expect(screen.getByText("wide v1으로 저장합니다.")).toBeDefined();
    await user.selectOptions(screen.getByLabelText("연결"), "local");
    await user.type(
      screen.getByLabelText("모델"),
      "claude-sonnet-5{Enter}claude-opus-5{Enter}claude-sonnet-5",
    );
    await user.selectOptions(
      screen.getByLabelText("기본 모델"),
      "claude-opus-5",
    );
    await user.type(screen.getByLabelText("도구"), "Read{Enter} Grep ");
    await user.selectOptions(screen.getByLabelText("권한 모드"), "auto");
    await user.click(screen.getByRole("checkbox", { name: "platform" }));
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/profiles/op_wide_v1"),
    );
    expect(posted(api)).toEqual([
      {
        name: "wide",
        connection_id: "local",
        runtime_kind: "claude_agent_sdk",
        runtime_version: "0.3.270",
        model: "claude-opus-5",
        models: ["claude-sonnet-5", "claude-opus-5"],
        tools: ["Read", "Grep"],
        permission_mode: "auto",
        project_settings: { claude_md: false },
        repository_mode: "required",
        repository_ids: ["platform"],
      },
    ]);
  });

  test("an empty form is caught before the request, each field saying what it needs", async () => {
    const { api } = renderAt(
      "/profiles/new?kind=installation",
      catalog().routes,
    );
    const user = await setupUser();
    await user.clear(await screen.findByLabelText("런타임 버전"));
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "이름은 영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText("런타임 버전을 200자 이하로 적으세요."),
    ).toBeDefined();
    expect(screen.getByText("모델을 하나 이상 고르세요.")).toBeDefined();
    // 저장소 필요 with none picked would leave no session able to start.
    expect(
      screen
        .getByRole("group", { name: "허용할 저장소" })
        .contains(
          screen.getByText(
            "저장소를 하나 이상 고르세요. 저장소 없이 돌리려면 '저장소 쓰지 않음'을 고릅니다.",
          ),
        ),
    ).toBe(true);
    expect(
      (screen.getByLabelText("이름") as HTMLInputElement).getAttribute(
        "aria-invalid",
      ),
    ).toBe("true");
    expect(posted(api)).toEqual([]);
  });

  test("a new version of a console ceiling keeps its name, names it as previous, and reviews only what changed", async () => {
    const server = catalog([CODING, ceiling("wide", 1), ceiling("wide", 2)]);
    const { api } = renderAt(
      "/profiles/new?kind=installation&from=op_wide_v2&mode=version",
      server.routes,
    );
    await screen.findByRole("heading", { level: 1, name: "wide 새 버전" });
    expect(screen.queryAllByRole("radiogroup").length).toBe(0);
    const name = (await screen.findByLabelText("이름")) as HTMLInputElement;
    expect(name.value).toBe("wide");
    expect(name.readOnly).toBe(true);
    expect(screen.getByText("wide v3으로 저장합니다.")).toBeDefined();
    expect(
      screen.getByText("op_wide_v2와 달라진 칸이 없습니다."),
    ).toBeDefined();
    const user = await setupUser();
    await user.click(screen.getByRole("checkbox", { name: "docs" }));
    const review = screen.getByRole("group", { name: "검토" });
    expect(
      Array.from(review.querySelectorAll("dt"), (term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]),
    ).toEqual([["허용할 저장소", "platform → docs, platform"]]);
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect(posted(api)[0]).toEqual({
      name: "wide",
      connection_id: "anthropic",
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5", "claude-haiku-5"],
      title_model: "claude-haiku-5",
      tools: ["Read", "Edit", "Bash"],
      permission_mode: "acceptEdits",
      project_settings: { claude_md: true },
      repository_mode: "required",
      repository_ids: ["platform", "docs"],
      previous_id: "op_wide_v2",
    });
  });

  test("a new version of an imported ceiling takes a new name and names the import as previous", async () => {
    const { api } = renderAt(
      "/profiles/new?kind=installation&from=coding-claude&mode=version",
      catalog().routes,
    );
    const name = (await screen.findByLabelText("이름")) as HTMLInputElement;
    expect(name.value).toBe("");
    expect(name.readOnly).toBe(false);
    const user = await setupUser();
    await user.type(name, "coding");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect(posted(api)[0]).toMatchObject({
      name: "coding",
      previous_id: "coding-claude",
    });
  });

  const REFUSALS: readonly [string, Record<string, unknown>, string, string][] =
    [
      [
        "unknown_connection",
        { reason_code: "unknown_connection", field: "connection_id" },
        "연결",
        "그 연결이 이 설치에 없습니다. 다시 불러와 연결을 고르세요.",
      ],
      [
        "runtime_not_installed",
        { reason_code: "runtime_not_installed", field: "runtime_kind" },
        "런타임",
        "이 설치의 worker가 그 런타임이나 권한 모드를 받지 않습니다.",
      ],
      [
        "unattended_not_allowed",
        { reason_code: "unattended_not_allowed", field: "permission_mode" },
        "권한 모드",
        "이 설치는 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS가 꺼져 있어 bypassPermissions 상한을 저장하지 않습니다.",
      ],
      [
        "model_not_in_models",
        { reason_code: "model_not_in_models", field: "model" },
        "기본 모델",
        "기본 모델은 모델 목록에 있어야 합니다.",
      ],
      [
        "invalid_profile",
        { reason_code: "invalid_profile", field: "models.0" },
        "모델",
        "이 값은 프로필로 저장할 수 없습니다.",
      ],
    ];

  for (const [reason, details, label, text] of REFUSALS) {
    test(`a ${reason} refusal shows beside ${label}`, async () => {
      renderAt("/profiles/new?kind=installation&from=coding-claude", {
        ...catalog().routes,
        "POST /v1/installation-profiles": () =>
          refusal(400, "BAD_REQUEST", details),
      });
      const user = await setupUser();
      await user.type(await screen.findByLabelText("이름"), "wide");
      await user.click(screen.getByRole("button", { name: "저장" }));
      const message = await screen.findByText(text);
      const field = screen.getByLabelText(label).closest("[data-slot=field]");
      expect(field?.contains(message)).toBe(true);
      // Beside the field only, not again in a banner above the buttons.
      expect(form().querySelectorAll("[data-slot=alert]")).toHaveLength(0);
    });
  }

  test("an unknown repository shows beside the repositories", async () => {
    renderAt("/profiles/new?kind=installation&from=coding-claude", {
      ...catalog().routes,
      "POST /v1/installation-profiles": () =>
        refusal(400, "BAD_REQUEST", {
          reason_code: "unknown_repository",
          field: "repository_ids",
        }),
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "wide");
    await user.click(screen.getByRole("button", { name: "저장" }));
    const message = await screen.findByText(
      "고른 저장소 가운데 이 설치에 없는 것이 있습니다. 다시 불러와 고르세요.",
    );
    expect(
      screen.getByRole("group", { name: "허용할 저장소" }).contains(message),
    ).toBe(true);
  });

  test("a taken id shows beside the name; a stale previous offers the latest version", async () => {
    let answer = refusal(409, "REVISION_CONFLICT", {
      reason_code: "id_taken",
      field: "name",
    });
    const server = catalog([CODING, ceiling("wide", 1)]);
    const { history } = renderAt(
      "/profiles/new?kind=installation&from=op_wide_v1&mode=version",
      {
        ...server.routes,
        "POST /v1/installation-profiles": () => answer,
      },
    );
    const user = await setupUser();
    await screen.findByLabelText("이름");
    await user.click(screen.getByRole("button", { name: "저장" }));
    const taken = await screen.findByText(
      "이 이름으로 만들 id가 이미 있습니다. 다른 이름을 고르세요.",
    );
    expect(
      screen
        .getByLabelText("이름")
        .closest("[data-slot=field]")
        ?.contains(taken),
    ).toBe(true);

    // Another owner saved v2 after this page read the list.
    server.items.push(ceiling("wide", 2));
    answer = refusal(409, "REVISION_CONFLICT", {
      reason_code: "stale_previous",
      latest_id: "op_wide_v2",
    });
    await user.click(screen.getByRole("button", { name: "저장" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "이 이름의 최신 버전은 op_wide_v2입니다. 새 버전은 최신 버전에서 만듭니다.",
    );
    await user.click(
      within(alert).getByRole("link", { name: "최신 버전에서 다시 만들기" }),
    );
    await waitFor(() =>
      expect(history.location.search).toContain("from=op_wide_v2"),
    );
    expect(
      await screen.findByText("op_wide_v2와 달라진 칸이 없습니다."),
    ).toBeDefined();
  });

  test("a refusal for the role says only an owner makes ceilings", async () => {
    renderAt("/profiles/new?kind=installation&from=coding-claude", {
      ...catalog().routes,
      "POST /v1/installation-profiles": () =>
        refusal(403, "FORBIDDEN", { reason_code: "role" }),
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "wide");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "설치 상한은 워크스페이스 owner만 만들고 사용 중지할 수 있습니다.",
    );
  });

  test("with no connection there is no form, and the page says why", async () => {
    renderAt(
      "/profiles/new?kind=installation",
      catalog(undefined, me(), { ...OPTIONS, connections: [] }).routes,
    );
    expect(
      await screen.findByText(
        "이 설치에 연결이 없습니다. 설치 설정에 연결을 둔 뒤 다시 여세요.",
      ),
    ).toBeDefined();
    expect(screen.getByRole("main").querySelector("form")).toBeNull();
  });

  test("English speaks the same refusals", async () => {
    renderAt(
      "/profiles/new?kind=installation&from=coding-claude",
      {
        ...catalog().routes,
        "POST /v1/installation-profiles": () =>
          refusal(400, "BAD_REQUEST", {
            reason_code: "unknown_connection",
            field: "connection_id",
          }),
      },
      "en",
    );
    const user = await setupUser();
    await user.type(await screen.findByLabelText("Name"), "wide");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "That connection is not on this installation. Reload and pick a connection.",
      ),
    ).toBeDefined();
  });
});
