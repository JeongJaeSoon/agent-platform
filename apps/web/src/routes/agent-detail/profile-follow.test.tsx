import { describe, expect, test } from "bun:test";
import type { AgentDetail } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import { apiError, json, me } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, within } = await appHarness();

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const DETAIL = `/agents/${AGENT_ID}`;
const PATH = `/v1/agents/${AGENT_ID}`;

function serverWith(extra: Partial<AgentDetail>) {
  const server = agentServer();
  let lifted = false;
  const patches: unknown[] = [];
  return {
    patches,
    routes: {
      ...meOk,
      ...server.routes,
      [`GET ${PATH}`]: () =>
        json(200, {
          ...server.detail(),
          ...(lifted ? { profile_tracking: "follow" } : extra),
        }),
    },
    onPatch: async (request: Request) => {
      patches.push(await request.json());
      lifted = true;
    },
  };
}

describe("an agent that does not follow its profile", () => {
  test("a pinned agent says so and one click brings it to the newest version", async () => {
    const state = serverWith({ profile_tracking: "pinned" });
    const { api } = renderAt(DETAIL, {
      ...state.routes,
      [`PATCH ${PATH}`]: async (request: Request) => {
        await state.onPatch(request);
        return json(200, {
          ...agentServer().detail(),
          profile_tracking: "follow",
          release: {
            status: "applied",
            reason: null,
            release_id: null,
            version_id: null,
          },
        });
      },
    });
    const user = await setupUser();
    expect(await screen.findByText("프로필의 옛 버전을 쓰는 중")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "최신으로 올리기" }));
    await screen.findByText("프로필의 최신 버전을 적용했습니다.");
    expect(state.patches).toEqual([{ follow_latest_profile: true }]);
    expect(
      api.calls.filter((call) => call.method === "PATCH").map((c) => c.path),
    ).toEqual([PATH]);
    expect(screen.queryByText("프로필의 옛 버전을 쓰는 중")).toBeNull();
  });

  test("a refused item says why in words and offers 다시 시도", async () => {
    const state = serverWith({
      profile_tracking: "follow",
      profile_rollout: {
        status: "failed",
        reason: "credential_unbound",
        target_profile_id: "op_ops_v2",
      },
    });
    renderAt(DETAIL, {
      ...state.routes,
      [`PATCH ${PATH}`]: async (request: Request) => {
        await state.onPatch(request);
        return json(200, {
          ...agentServer().detail(),
          release: {
            status: "failed",
            reason: "retries_exhausted",
            release_id: null,
            version_id: null,
          },
        });
      },
    });
    const user = await setupUser();
    const alert = (
      await screen.findByText("프로필 새 버전을 적용하지 못했습니다")
    ).closest("[role=alert], [data-slot=alert]") as HTMLElement;
    expect(within(alert).getByText(/이유: /)).toBeDefined();
    await user.click(within(alert).getByRole("button", { name: "다시 시도" }));
    expect(
      await screen.findByText(
        "최신으로 올리지 못했습니다: 여러 번 시도했지만 적용하지 못했습니다",
      ),
    ).toBeDefined();
  });

  test("a request another one overtook says it was superseded, not applied", async () => {
    const state = serverWith({ profile_tracking: "pinned" });
    renderAt(DETAIL, {
      ...state.routes,
      [`PATCH ${PATH}`]: () =>
        json(200, {
          ...agentServer().detail(),
          profile_tracking: "pinned",
          release: {
            status: "superseded",
            reason: null,
            release_id: null,
            version_id: null,
          },
        }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "최신으로 올리기" }),
    );
    await screen.findByText(/더 나중의 저장이 먼저 적용되어/);
    expect(screen.queryByText("프로필의 최신 버전을 적용했습니다.")).toBeNull();
  });

  test("a refused request shows the refusal and keeps the note", async () => {
    const state = serverWith({ profile_tracking: "pinned" });
    renderAt(DETAIL, {
      ...state.routes,
      [`PATCH ${PATH}`]: () => apiError(403, "FORBIDDEN", "role"),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "최신으로 올리기" }),
    );
    await screen.findByRole("button", { name: "최신으로 올리기" });
    expect(screen.getByText("프로필의 옛 버전을 쓰는 중")).toBeDefined();
  });

  test("an agent that follows with nothing open shows no note", async () => {
    const state = serverWith({ profile_tracking: "follow" });
    renderAt(DETAIL, state.routes);
    await screen.findByRole("tab", { name: "개요" });
    expect(screen.queryByText("프로필의 옛 버전을 쓰는 중")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "최신으로 올리기" }),
    ).toBeNull();
  });
});
