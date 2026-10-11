import { describe, expect, test } from "bun:test";
import { agentDetailSchema } from "@agent-platform/contracts";
import { setupUser } from "@agent-platform/ui/test-support/dom";
import { queryKeys } from "../api/queries.ts";
import { AGENT_ID, agentServer, CARD } from "../test-support/fake-agents.ts";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const DETAIL = `/agents/${AGENT_ID}`;

describe("에이전트 목록", () => {
  test("fake 서버의 응답은 서버가 보낼 수 있는 모양이다", () => {
    expect(agentDetailSchema.safeParse(agentServer().detail()).success).toBe(
      true,
    );
  });

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
