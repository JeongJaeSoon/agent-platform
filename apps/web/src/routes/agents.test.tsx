import { describe, expect, test } from "bun:test";
import { agentDetailSchema } from "@agent-platform/contracts";
import { setupUser } from "@agent-platform/ui/test-support/dom";
import { queryKeys } from "../api/queries.ts";
import { AGENT_ID, agentServer, CARD } from "../test-support/fake-agents.ts";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const DETAIL = `/agents/${AGENT_ID}`;
const PROFILE = "claude-coding-local";

async function seedRelease(server: ReturnType<typeof agentServer>) {
  const handler = server.routes[`POST /v1/agents/${AGENT_ID}/releases`];
  const versionId = server.versions.at(-1)?.id ?? "";
  await handler?.(
    new Request("https://console.test/", {
      method: "POST",
      body: JSON.stringify({
        version_id: versionId,
        runtime_profile_id: PROFILE,
      }),
    }),
  );
}

describe("에이전트 목록", () => {
  test("목록과 상태를 보이고 상세로 잇는다", async () => {
    const server = agentServer();
    renderAt("/agents", { ...meOk, ...server.routes });
    const link = await screen.findByRole("link", { name: "결제 담당" });
    expect(link.getAttribute("href")).toBe(DETAIL);
    expect(screen.getByText("활성 release 없음")).toBeDefined();
  });

  test("agent.manage가 없으면 새 에이전트 버튼을 끈 채 이유를 적는다", async () => {
    renderAt("/agents", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/agents": () =>
        apiError(403, "FORBIDDEN", "This principal does not hold agent.manage"),
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "does not hold agent.manage",
    );
    const button = screen.getByRole("button", { name: "새 에이전트" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("agent.manage 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.");
  });
});

describe("새 에이전트", () => {
  test("빈 카드 폼으로 시작하고, 만들면 상세로 가서 아직 활성이 아니라고 말한다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "POST /v1/agents": () => json(201, server.detail()),
    });
    const user = await setupUser();
    expect(
      ((await screen.findByLabelText("역할")) as HTMLInputElement).value,
    ).toBe("");
    expect(screen.queryByRole("button", { name: /초안/ })).toBeNull();
    await user.type(screen.getByLabelText("이름"), "결제 담당");
    await user.type(screen.getByLabelText("주소 이름"), "billing");
    await user.type(screen.getByLabelText("역할"), CARD.role);
    await user.type(screen.getByLabelText("지시"), CARD.instructions);
    await user.type(screen.getByLabelText("모델"), CARD.model);
    await user.type(screen.getByLabelText("금지 도구"), "Bash{Enter}Write");
    await user.click(screen.getByRole("button", { name: "에이전트 만들기" }));
    expect(
      await screen.findByText(/에이전트를 만들었습니다\(version 1\)/),
    ).toBeDefined();
    expect(history.location.pathname).toBe(DETAIL);
    expect(
      api.calls.find((c) => c.path === "/v1/agents" && c.method === "POST")
        ?.body,
    ).toEqual({
      slug: "billing",
      name: "결제 담당",
      card: {
        ...CARD,
        capabilities: { tools: null, mcp: null, forbidden: ["Bash", "Write"] },
      },
    });
  });
});

describe("에이전트 상세", () => {
  test("카드를 고치면 새 version으로 저장했다고 하고, 두 version의 차이를 보인다", async () => {
    const server = agentServer();
    const { api } = renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시");
    await user.clear(instructions);
    await user.type(instructions, "환불 문의에도 답한다.");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        /저장했습니다 — version 2\. 아직 활성화되지 않았습니다/,
      ),
    ).toBeDefined();
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
    expect((screen.getByLabelText("지시") as HTMLTextAreaElement).value).toBe(
      "환불 문의에도 답한다.",
    );
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect((patch?.body as { card: unknown }).card).toEqual({
      ...CARD,
      instructions: "환불 문의에도 답한다.",
    });
    const diff = await screen.findByText("version 1 → version 2");
    const figure = diff.closest("figure") as HTMLElement;
    expect(
      figure.querySelector('[data-kind="removed"]')?.textContent,
    ).toContain("결제 문의에 답한다.");
    expect(figure.querySelector('[data-kind="added"]')?.textContent).toContain(
      "환불 문의에도 답한다.",
    );
  });

  test("이미 있는 version과 같은 카드로 저장하면 그 version을 저장 결과로 본다", async () => {
    const server = agentServer();
    renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시");
    await user.clear(instructions);
    await user.type(instructions, "환불 문의에도 답한다.");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다 — version 2/);
    await user.clear(screen.getByLabelText("지시"));
    await user.type(screen.getByLabelText("지시"), CARD.instructions);
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "저장했습니다. 같은 카드가 이미 있어(version 1) 새 version은 생기지 않았습니다.",
      ),
    ).toBeDefined();
    expect((screen.getByLabelText("지시") as HTMLTextAreaElement).value).toBe(
      CARD.instructions,
    );
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
    const release = screen
      .getByRole("heading", { name: "release" })
      .closest("section") as HTMLElement;
    expect(
      (within(release).getByLabelText("version") as HTMLSelectElement)
        .selectedOptions[0]?.textContent,
    ).toBe("version 1");
  });

  test("바뀐 것 없이 저장하면 새 version이 없다고 말한다", async () => {
    const server = agentServer();
    renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "저장했습니다. 카드 내용이 같아 새 version은 생기지 않았습니다.",
      ),
    ).toBeDefined();
  });

  test("release를 만들고 활성화한다: 저장·release·활성화는 서로 다른 문구다", async () => {
    const server = agentServer();
    const { api } = renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    const profile = await screen.findByLabelText("runtime profile");
    await user.type(profile, "no-such-profile");
    await user.click(screen.getByRole("button", { name: "release 만들기" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Unknown runtime profile no-such-profile",
    );
    await user.clear(profile);
    await user.type(profile, PROFILE);
    await user.click(screen.getByRole("button", { name: "release 만들기" }));
    expect(
      await screen.findByText(
        "release를 만들었습니다(version 1). 아직 활성화되지 않았습니다.",
      ),
    ).toBeDefined();
    await user.click(
      await screen.findByRole("button", {
        name: `version 1 · ${PROFILE} 활성화`,
      }),
    );
    expect(
      await screen.findByText(
        `활성화됐습니다 — 이제 새 세션은 version 1 · ${PROFILE}(으)로 시작합니다.`,
      ),
    ).toBeDefined();
    const activate = api.calls.find((c) => c.path.endsWith("/activate"));
    expect(activate?.body).toEqual({
      release_id: server.releases[0]?.id,
      expected_revision: -1,
    });
    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(`활성 release: version 1 · ${PROFILE}`)),
      ).toBeDefined(),
    );
    expect(agentDetailSchema.safeParse(server.detail()).success).toBe(true);
  });
  test("새 version을 저장하면 release 폼도 그 version을 고른다", async () => {
    const server = agentServer();
    renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시");
    await user.clear(instructions);
    await user.type(instructions, "환불 문의에도 답한다.");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다 — version 2/);
    const release = screen
      .getByRole("heading", { name: "release" })
      .closest("section") as HTMLElement;
    await waitFor(() =>
      expect(
        (within(release).getByLabelText("version") as HTMLSelectElement)
          .selectedOptions[0]?.textContent,
      ).toBe("version 2"),
    );
  });
});

describe("두 탭 동시 활성화", () => {
  test("늦은 탭은 덮어쓰지 않고(409) 재조회와 차이를 안내한 뒤에야 다시 활성화한다", async () => {
    const server = agentServer();
    await seedRelease(server);
    server.versions.push({
      ...(server.versions[0] as (typeof server.versions)[number]),
      id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      version_no: 2,
      card: { ...CARD, instructions: "환불도 맡는다." },
      content_sha256: "f".repeat(64),
    });
    await seedRelease(server);
    const [first, second] = server.releases;
    const label = (no: number) => `version ${no} · ${PROFILE}`;

    const tabA = renderAt(DETAIL, { ...meOk, ...server.routes });
    const tabB = renderAt(DETAIL, { ...meOk, ...server.routes });
    const a = within(tabA.container);
    const b = within(tabB.container);
    const user = await setupUser();
    const activateB = await b.findByRole("button", {
      name: `${label(2)} 활성화`,
    });
    await user.click(
      await a.findByRole("button", { name: `${label(1)} 활성화` }),
    );
    expect(await a.findByText(/활성화됐습니다/)).toBeDefined();

    await user.click(activateB);
    const conflict = await b.findByText("다른 곳에서 먼저 활성화를 바꿨습니다");
    const panel = conflict.closest("section") as HTMLElement;
    expect(panel.textContent).toContain("덮어쓰지 않고 멈췄습니다");
    expect(b.queryByText(/활성화됐습니다/)).toBeNull();
    const fromB = tabB.api.calls.filter((c) => c.path.endsWith("/activate"));
    expect(fromB).toHaveLength(1);
    expect(fromB[0]?.body).toEqual({
      release_id: second?.id,
      expected_revision: -1,
    });

    await user.click(
      within(panel).getByRole("button", { name: "최신 상태 불러오기" }),
    );
    expect(
      await b.findByText(
        `보던 화면의 활성 release: 없음. 지금 활성 release: ${label(1)}. 아래 차이를 확인하고 필요하면 다시 활성화하세요.`,
      ),
    ).toBeDefined();
    expect(b.getByText(`없음 → ${label(1)}`)).toBeDefined();

    await user.click(b.getByRole("button", { name: `${label(2)} 활성화` }));
    expect(await b.findByText(/활성화됐습니다/)).toBeDefined();
    const retry = tabB.api.calls.filter((c) => c.path.endsWith("/activate"));
    expect(retry.at(-1)?.body).toEqual({
      release_id: second?.id,
      expected_revision: 0,
    });
    expect(server.detail().agent.active_release_id).toBe(second?.id ?? "");
    expect(first).toBeDefined();
  });
});

describe("편집 중 다른 곳의 저장", () => {
  function otherTabSaves(server: ReturnType<typeof agentServer>) {
    server.versions.push({
      ...(server.versions[0] as (typeof server.versions)[number]),
      id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      version_no: 2,
      card: { ...CARD, instructions: "다른 탭이 고친 지시." },
      content_sha256: "e".repeat(64),
    });
  }

  test("고치던 내용은 재조회로 사라지지 않고, 최신이 생겼다고 알린 뒤 원할 때만 불러온다", async () => {
    const server = agentServer();
    const { services } = renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시");
    await user.clear(instructions);
    await user.type(instructions, "내가 고치던 지시.");
    otherTabSaves(server);
    await services.queryClient.invalidateQueries({
      queryKey: queryKeys.agent(AGENT_ID),
    });
    expect(
      await screen.findByText(
        "다른 곳에서 카드를 저장해 최신이 version 2입니다. 고치던 내용은 그대로 두었습니다. 이대로 저장하면 이 내용이 다음 version이 됩니다.",
      ),
    ).toBeDefined();
    expect((screen.getByLabelText("지시") as HTMLTextAreaElement).value).toBe(
      "내가 고치던 지시.",
    );
    await user.click(
      screen.getByRole("button", { name: "최신 카드 불러오기" }),
    );
    expect((screen.getByLabelText("지시") as HTMLTextAreaElement).value).toBe(
      "다른 탭이 고친 지시.",
    );
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
  });

  test("release 폼은 적어 둔 profile을 지키면서 새 version을 기본으로 고른다", async () => {
    const server = agentServer();
    const { services } = renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("runtime profile"), PROFILE);
    otherTabSaves(server);
    await services.queryClient.invalidateQueries({
      queryKey: queryKeys.agent(AGENT_ID),
    });
    const release = screen
      .getByRole("heading", { name: "release" })
      .closest("section") as HTMLElement;
    await waitFor(() =>
      expect(
        (within(release).getByLabelText("version") as HTMLSelectElement)
          .selectedOptions[0]?.textContent,
      ).toBe("version 2"),
    );
    expect(
      (within(release).getByLabelText("runtime profile") as HTMLInputElement)
        .value,
    ).toBe(PROFILE);
  });

  test("저장 응답을 기다리는 동안 이어서 쓴 내용은 응답이 와도 남는다", async () => {
    const server = agentServer();
    const patch = server.routes[`PATCH /v1/agents/${AGENT_ID}`];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: async (request: Request) => {
        await gate;
        return patch ? patch(request) : json(500, {});
      },
    });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시");
    await user.clear(instructions);
    await user.type(instructions, "첫 저장.");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.type(screen.getByLabelText("지시"), " 이어서 쓴 줄.");
    release();
    expect(await screen.findByText(/저장했습니다 — version 2/)).toBeDefined();
    expect((screen.getByLabelText("지시") as HTMLTextAreaElement).value).toBe(
      "첫 저장. 이어서 쓴 줄.",
    );
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
  });

  test("다른 에이전트로 옮기면 이전 에이전트의 편집을 들고 가지 않는다", async () => {
    const server = agentServer();
    const OTHER = "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
    const other = server.detail();
    const otherDetail = {
      ...other,
      agent: { ...other.agent, id: OTHER, slug: "refund", name: "환불 담당" },
      versions: other.versions.map((v) => ({
        ...v,
        agent_id: OTHER,
        card: { ...CARD, instructions: "환불 문의에 답한다." },
      })),
    };
    const { api, history } = renderAt(`/agents/${OTHER}`, {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${OTHER}`]: () => json(200, otherDetail),
      [`PATCH /v1/agents/${OTHER}`]: () => json(200, otherDetail),
    });
    // Visit the other agent first so it is cached when we come back to it.
    await screen.findByRole("heading", { name: "환불 담당" });
    history.push(DETAIL);
    await screen.findByRole("heading", { name: "결제 담당" });
    const user = await setupUser();
    const instructions = screen.getByLabelText("지시");
    await user.clear(instructions);
    await user.type(instructions, "결제 담당에게만 쓴 지시.");
    history.push(`/agents/${OTHER}`);
    await screen.findByRole("heading", { name: "환불 담당" });
    expect((screen.getByLabelText("지시") as HTMLTextAreaElement).value).toBe(
      "환불 문의에 답한다.",
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다/);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe(`/v1/agents/${OTHER}`);
    expect(JSON.stringify(patch?.body)).not.toContain("결제 담당에게만");
  });

  test("카드만 고쳤으면 다른 곳의 이름 변경을 되돌리지 않는다", async () => {
    const server = agentServer();
    let renamed = false;
    const get = () => {
      const detail = server.detail();
      return json(200, {
        ...detail,
        agent: { ...detail.agent, name: renamed ? "청구 담당" : "결제 담당" },
      });
    };
    const { api, services } = renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}`]: get,
    });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시");
    await user.clear(instructions);
    await user.type(instructions, "카드만 고친다.");
    renamed = true;
    await services.queryClient.invalidateQueries({
      queryKey: queryKeys.agent(AGENT_ID),
    });
    await screen.findByRole("heading", { name: "청구 담당" });
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다/);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).not.toHaveProperty("name");
  });

  test("고친 것이 없으면 최신 카드를 그대로 받아들인다", async () => {
    const server = agentServer();
    const { services } = renderAt(DETAIL, { ...meOk, ...server.routes });
    await screen.findByLabelText("지시");
    otherTabSaves(server);
    await services.queryClient.invalidateQueries({
      queryKey: queryKeys.agent(AGENT_ID),
    });
    await waitFor(() =>
      expect((screen.getByLabelText("지시") as HTMLTextAreaElement).value).toBe(
        "다른 탭이 고친 지시.",
      ),
    );
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
  });
});
