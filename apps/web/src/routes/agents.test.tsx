import { describe, expect, test } from "bun:test";
import { agentDetailSchema } from "@agent-platform/contracts";
import { setupUser } from "@agent-platform/ui/test-support/dom";
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
    await user.type(screen.getByLabelText("금지 도구"), "Bash, Write");
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
        `보던 화면의 활성 release는 없음였고, 지금은 ${label(1)}입니다. 아래 차이를 확인하고 필요하면 다시 활성화하세요.`,
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
