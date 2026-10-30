import { describe, expect, test } from "bun:test";
import type { components } from "@werft-ai/client";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import { json, me, RECEIPT_ID } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();
// After the harness: the screen pulls in @werft-ai/ui, which must load
// against the test DOM.
const { pendingCount, refusesAgentRef } = await import("./github.tsx");
const PATH = `/v1/agents/${AGENT_ID}`;
const DETAIL = `/agents/${AGENT_ID}?tab=github`;
const SESSION = "00000000-0000-4000-8000-0000000000c1";

type Tab = components["schemas"]["AgentGitHubResponse"];
type Settings = NonNullable<Tab["github"]>;

const SETTINGS: Settings = {
  repositories: ["werft-sandbox"],
  push_approval: true,
  features: {
    workflows: false,
    actions: true,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [{ workflow: "ci.yml", ref: "release/*" }],
};
const open = { available: true, reason: null } as const;
const TAB: Tab = {
  enabled: true,
  active_release_id: null,
  release_repository_id: "werft-sandbox",
  github: SETTINGS,
  legacy_defaults: null,
  unsavable: null,
  options: {
    repositories: [
      {
        id: "werft-sandbox",
        url: "https://github.com/acme/werft-sandbox",
        available: true,
        reason: null,
      },
      {
        id: "docs-site",
        url: "https://github.com/acme/docs-site",
        available: true,
        reason: null,
      },
    ],
    features: {
      workflows: open,
      actions: open,
      checks: open,
      issues: open,
      review: open,
    },
  },
};

/** An agent whose v1 is released under claude-coding-local and active. */
async function activeAgent() {
  const server = agentServer();
  const call = (key: string, body: unknown) =>
    (
      server.routes as unknown as Record<
        string,
        (request: Request) => Promise<Response>
      >
    )[key]?.(
      new Request("http://test", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  const versionId = server.versions[0]?.id ?? "";
  await call(`POST ${PATH}/releases`, {
    version_id: versionId,
    runtime_profile_id: "claude-coding-local",
    repository_id: "werft-sandbox",
  });
  const release = server.releases[0];
  if (!release) throw new Error("no release");
  release.policy_pins = { github: SETTINGS };
  await call(`POST ${PATH}/activate`, {
    release_id: release.id,
    expected_revision: -1,
  });
  return { server, release, versionId };
}

function routesFor(
  server: ReturnType<typeof agentServer>,
  tab: Tab,
  extra: Record<
    string,
    (request: Request) => Response | Promise<Response>
  > = {},
) {
  return {
    "GET /v1/auth/me": () => json(200, me()),
    ...server.routes,
    [`GET ${PATH}/github`]: () =>
      json(200, {
        ...tab,
        active_release_id: server.detail().agent.active_release_id,
      }),
    [`GET ${PATH}/github/activity`]: () => json(200, { items: [] }),
    ...extra,
  };
}

const switchNamed = (name: string) =>
  screen.getByRole("switch", { name }) as HTMLButtonElement;

describe("에이전트 GitHub 탭", () => {
  test("쓸 수 없는 저장소와 권한은 여섯 가지 이유를 그 행에 적고 스위치를 잠근다", async () => {
    const { server } = await activeAgent();
    const reason = <R,>(r: R) => ({ available: false, reason: r });
    renderAt(
      DETAIL,
      routesFor(server, {
        ...TAB,
        github: {
          ...SETTINGS,
          features: { ...SETTINGS.features, actions: false },
        },
        options: {
          repositories: [
            ...TAB.options.repositories,
            {
              id: "billing-api",
              url: "https://github.com/acme/billing-api",
              ...reason("repository_not_allowed" as const),
            },
            {
              id: "legacy-pat",
              url: "https://github.com/acme/legacy-pat",
              ...reason("app_required" as const),
            },
          ],
          features: {
            workflows: reason("app_permission_missing" as const),
            actions: open,
            checks: reason("over_workspace_ceiling" as const),
            issues: reason("github_host_unsupported" as const),
            review: reason("no_reviewer_app" as const),
          },
        },
      }),
    );
    await screen.findByRole("heading", { name: "저장소" });
    const rowOf = (name: string) =>
      switchNamed(name).closest("li") as HTMLElement;
    const expectLocked = (name: string, text: RegExp) => {
      expect(switchNamed(name).disabled).toBe(true);
      expect(within(rowOf(name)).getByText(text)).toBeTruthy();
    };
    expectLocked("billing-api", /실행 프로필이 이 저장소를 허용하지 않습니다/);
    expectLocked("legacy-pat", /PAT로 연결된 저장소라/);
    expectLocked("워크플로 파일 수정", /App에 이 권한이 없습니다/);
    expectLocked("검사 결과 쓰기", /워크스페이스 상한 밖입니다/);
    expectLocked("이슈 쓰기", /GitHub Enterprise에 있어/);
    expectLocked("리뷰 승인", /리뷰용 App이 없습니다/);
    // The release's repository stays; others with no reason may change.
    expect(switchNamed("werft-sandbox").disabled).toBe(true);
    expect(switchNamed("docs-site").disabled).toBe(false);
    expect(switchNamed("Actions 실행").disabled).toBe(false);
    // A ceiling reason links to where it is lifted; the host one does not.
    expect(
      within(rowOf("검사 결과 쓰기"))
        .getByRole("link", { name: "GitHub 연결 설정" })
        .getAttribute("href"),
    ).toBe("/settings/workspace/github");
    expect(
      within(rowOf("이슈 쓰기")).queryByRole("link", {
        name: "GitHub 연결 설정",
      }),
    ).toBeNull();
  });

  test("바꾼 것은 저장 전 상자에 세고, 되돌리면 상자가 사라진다", async () => {
    const { server } = await activeAgent();
    renderAt(DETAIL, routesFor(server, TAB));
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    expect(screen.queryByText(/릴리스에 넣지 않은 변경/)).toBeNull();

    await user.click(switchNamed("docs-site"));
    await screen.findByText("릴리스에 넣지 않은 변경 1건");
    await user.type(screen.getByLabelText("워크플로 파일"), "deploy.yml");
    await user.type(screen.getByLabelText("ref 패턴(선택)"), "main");
    await user.click(screen.getByRole("button", { name: "워크플로 추가" }));
    await screen.findByText("릴리스에 넣지 않은 변경 2건");
    const added = screen.getByText("deploy.yml").closest("li") as HTMLElement;
    expect(within(added).getByText("저장 전")).toBeTruthy();
    // A held entry carries no such badge.
    const held = screen.getByText("ci.yml").closest("li") as HTMLElement;
    expect(within(held).queryByText("저장 전")).toBeNull();

    await user.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() =>
      expect(screen.queryByText(/릴리스에 넣지 않은 변경/)).toBeNull(),
    );
    expect(screen.queryByText("deploy.yml")).toBeNull();
    expect(switchNamed("docs-site").getAttribute("aria-checked")).toBe("false");
  });

  test("허용 목록은 agent/ 브랜치와 경로·중복을 받지 않는다", async () => {
    const { server } = await activeAgent();
    renderAt(DETAIL, routesFor(server, TAB));
    const user = await setupUser();
    const file = await screen.findByLabelText("워크플로 파일");
    const ref = screen.getByLabelText("ref 패턴(선택)");
    const add = screen.getByRole("button", { name: "워크플로 추가" });

    await user.type(file, ".github/workflows/ci.yml");
    await user.click(add);
    await screen.findByText(/\.yml이나 \.yaml로 끝나는 파일 이름만/);
    await user.clear(file);
    await user.type(file, "ci.yml");
    await user.type(ref, "agent/*");
    await user.click(add);
    await screen.findByText(/agent\/ 브랜치는 에이전트가 내용을 정하므로/);
    await user.clear(ref);
    await user.type(ref, "release/*");
    await user.click(add);
    await screen.findByText("이미 목록에 있는 항목입니다.");
    expect(screen.queryByText(/릴리스에 넣지 않은 변경/)).toBeNull();
  });

  test("새 릴리스로 저장하면 같은 카드 버전·실행 프로필로 릴리스를 만들고 활성화한다", async () => {
    const { server, release, versionId } = await activeAgent();
    const sent: unknown[] = [];
    const activated: unknown[] = [];
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`POST ${PATH}/releases`]: async (request) => {
          const body = (await request.json()) as {
            github: Settings;
            version_id: string;
            runtime_profile_id: string;
            repository_id?: string;
          };
          sent.push(body);
          const made = {
            ...release,
            id: "rel-github-2",
            label: "2026-10-30_10:00:00",
            policy_pins: { github: body.github },
          };
          server.releases.push(made);
          return json(200, { release: made, created: true });
        },
        [`POST ${PATH}/activate`]: async (request) => {
          activated.push(await request.json());
          return json(200, {
            active_release_id: "rel-github-2",
            previous_release_id: release.id,
            activation_revision: 1,
            receipt_id: RECEIPT_ID,
          });
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await user.click(switchNamed("push 전 사람 승인"));
    await user.click(
      await screen.findByRole("button", { name: "새 릴리스로 저장" }),
    );

    await screen.findByText(
      "새 릴리스 2026-10-30_10:00:00를 만들고 활성화했습니다.",
    );
    expect(sent).toEqual([
      {
        version_id: versionId,
        runtime_profile_id: "claude-coding-local",
        repository_id: "werft-sandbox",
        github: { ...SETTINGS, push_approval: false },
      },
    ]);
    expect(activated).toEqual([
      { release_id: "rel-github-2", expected_revision: 0 },
    ]);
    await waitFor(() =>
      expect(screen.queryByText(/릴리스에 넣지 않은 변경/)).toBeNull(),
    );
  });

  test("다른 사람이 먼저 활성화하면 저장한 릴리스를 덮어쓰지 않고 알린다", async () => {
    const { server } = await activeAgent();
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`POST ${PATH}/activate`]: () =>
          json(409, {
            error: {
              code: "REVISION_CONFLICT",
              message: "The agent was activated by someone else",
              retryable: false,
              request_id: "req-1",
            },
          }),
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await user.click(switchNamed("push 전 사람 승인"));
    await user.click(
      await screen.findByRole("button", { name: "새 릴리스로 저장" }),
    );
    await screen.findByText(/다른 사람이 그 사이 에이전트를 활성화했습니다/);
    // The draft stays for another try.
    expect(screen.getByText("릴리스에 넣지 않은 변경 1건")).toBeTruthy();
  });

  test("다른 사람이 활성화한 뒤 다시 읽어도, 그 전에 만든 초안은 저장하지 않는다", async () => {
    const { server, release } = await activeAgent();
    const routes = server.routes as unknown as Record<
      string,
      (request: Request) => Promise<Response>
    >;
    let made = 0;
    let detailReads = 0;
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`GET ${PATH}`]: (request) => {
          detailReads += 1;
          return routes[`GET ${PATH}`]?.(request) ?? json(404, {});
        },
        [`POST ${PATH}/releases`]: (request) => {
          made += 1;
          return routes[`POST ${PATH}/releases`]?.(request) ?? json(404, {});
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await user.click(switchNamed("push 전 사람 승인"));
    // Someone else activates another release while the draft is open.
    server.releases.push({
      ...release,
      id: "rel-other",
      label: "2026-10-11_11:00:00",
    });
    await routes[`POST ${PATH}/activate`]?.(
      new Request("http://test", {
        method: "POST",
        body: JSON.stringify({ release_id: "rel-other", expected_revision: 0 }),
      }),
    );
    expect(server.detail().agent.activation_revision).toBe(1);

    const before = detailReads;
    await user.click(
      await screen.findByRole("button", { name: "새 릴리스로 저장" }),
    );
    await screen.findByText(/릴리스 탭에서 확인한 뒤 활성화하세요/);
    await waitFor(() => expect(detailReads).toBeGreaterThan(before));

    await user.click(screen.getByRole("button", { name: "새 릴리스로 저장" }));
    await screen.findByText(/저장하지 않았습니다/);
    expect(made).toBe(1);
    expect(server.detail().agent.activation_revision).toBe(1);
  });

  test("Actions를 끄면 허용 목록도 비워서 저장한다", async () => {
    const { server } = await activeAgent();
    const sent: Settings[] = [];
    const routes = server.routes as unknown as Record<
      string,
      (request: Request) => Promise<Response>
    >;
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`POST ${PATH}/releases`]: async (request) => {
          sent.push(
            ((await request.clone().json()) as { github: Settings }).github,
          );
          return routes[`POST ${PATH}/releases`]?.(request) ?? json(404, {});
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "Actions 허용 목록" });
    await user.click(switchNamed("Actions 실행"));
    expect(
      screen.queryByRole("heading", { name: "Actions 허용 목록" }),
    ).toBeNull();
    expect(screen.getByText("릴리스에 넣지 않은 변경 2건")).toBeTruthy();
    await user.click(
      await screen.findByRole("button", { name: "새 릴리스로 저장" }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.features.actions).toBe(false);
    expect(sent[0]?.actions_allow).toEqual([]);
  });

  test("GitHub 사용을 끄려면 확인을 거치고, 꺼지면 설정은 읽기만 한다", async () => {
    const { server } = await activeAgent();
    let enabled = true;
    const puts: unknown[] = [];
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`GET ${PATH}/github`]: () => json(200, { ...TAB, enabled }),
        [`PUT ${PATH}/github/enabled`]: async (request) => {
          const body = (await request.json()) as { enabled: boolean };
          puts.push(body);
          enabled = body.enabled;
          return json(200, { enabled, receipt_id: RECEIPT_ID });
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    await user.click(switchNamed("GitHub 사용"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/진행 중인 세션도 다음 GitHub 요청부터/),
    ).toBeTruthy();
    expect(puts).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "끄기" }));
    await screen.findByText(
      "GitHub 사용이 꺼져 있어 아래 설정은 읽기만 할 수 있습니다.",
    );
    expect(puts).toEqual([{ enabled: false }]);
    expect(switchNamed("docs-site").disabled).toBe(true);
    expect(switchNamed("push 전 사람 승인").disabled).toBe(true);
  });

  test("저장할 수 없는 릴리스는 이유를 보이고, 기록은 세션으로 잇는다", async () => {
    const { server } = await activeAgent();
    const receipt: components["schemas"]["Receipt"] = {
      id: RECEIPT_ID,
      operation: "dispatch_workflow",
      target_ref: { session_id: SESSION, turn_id: null, request_id: null },
      status: "failed",
      result: {
        session_id: SESSION,
        repository_id: "werft-sandbox",
        purpose: "dispatch",
        workflow: "deploy.yml",
        ref: "main",
        reason_code: "workflow_not_allowed",
      },
      error: { code: "GITHUB_REFUSED", message: "GitHub work refused" },
      created_at: "2026-10-30T00:00:00.000Z",
      updated_at: "2026-10-30T00:00:00.000Z",
    };
    renderAt(
      DETAIL,
      routesFor(
        server,
        { ...TAB, github: null, unsavable: "app_required" },
        {
          [`GET ${PATH}/github/activity`]: () =>
            json(200, { items: [receipt] }),
        },
      ),
    );
    await screen.findByText("GitHub 설정을 저장할 수 없습니다");
    expect(screen.queryByRole("heading", { name: "저장소" })).toBeNull();
    const rows = await screen.findByRole("list", { name: "최근 기록" });
    expect(within(rows).getByText("워크플로 실행 거절")).toBeTruthy();
    expect(
      within(rows).getByText(
        /^deploy\.yml @ main · werft-sandbox · 허용 목록 밖 ·$/,
      ),
    ).toBeTruthy();
    expect(
      within(rows).getByRole("link", { name: /세션/ }).getAttribute("href"),
    ).toBe(`/sessions/${SESSION}`);
  });
});

describe("GitHub 탭 계산", () => {
  test("agent/ 브랜치를 가리킬 수 있는 ref 패턴을 알아본다", () => {
    expect(refusesAgentRef("agent/*")).toBe(true);
    expect(refusesAgentRef("ag*/x")).toBe(true);
    expect(refusesAgentRef("*/x")).toBe(true);
    expect(refusesAgentRef("release/*")).toBe(false);
    expect(refusesAgentRef("main")).toBe(false);
    expect(refusesAgentRef("agent")).toBe(false);
  });

  test("바뀐 저장소·권한·허용 목록 항목을 하나씩 센다", () => {
    expect(pendingCount(SETTINGS, SETTINGS)).toBe(0);
    expect(
      pendingCount(SETTINGS, {
        ...SETTINGS,
        repositories: ["docs-site"],
        features: { ...SETTINGS.features, review: true },
        actions_allow: [{ workflow: "ci.yml" }],
      }),
    ).toBe(5);
  });
});
