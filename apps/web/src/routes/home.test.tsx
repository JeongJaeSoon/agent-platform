import { describe, expect, test } from "bun:test";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const owner = {
  user_id: USER_ID,
  email: "owner@example.com",
  display_name: "Owner",
  role: "owner",
  disabled_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
};

async function states() {
  await screen.findByRole("heading", { name: "Acme" });
  return () =>
    screen
      .getAllByRole("listitem")
      .map((step) => step.getAttribute("data-state"));
}

describe("bootstrap checklist", () => {
  test("처음에는 관리자만 완료이고, 초대·에이전트 단계는 각 화면으로 잇는다", async () => {
    const server = agentServer();
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": server.routes["GET /v1/agents"],
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "pending", "pending", "pending"]),
    );
    expect(
      screen
        .getByRole("link", { name: "구성원 초대하기" })
        .getAttribute("href"),
    ).toBe("/members");
    expect(
      screen
        .getByRole("link", { name: "에이전트 준비하기" })
        .getAttribute("href"),
    ).toBe("/agents");
  });

  test("초대를 보냈고 활성 release가 있는 에이전트가 있으면 두 단계가 완료다", async () => {
    const server = agentServer();
    const agent = { ...server.detail().agent, active_release_id: "rel-1" };
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () =>
        json(200, {
          items: [
            {
              id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
              workspace_id: me().workspace?.id,
              email: "late@example.com",
              role: "member",
              invited_by: USER_ID,
              status: "pending",
              expires_at: "2026-10-18T00:00:00.000Z",
              accepted_at: null,
              revoked_at: null,
              created_at: "2026-10-11T00:00:00.000Z",
            },
          ],
        }),
      "GET /v1/agents": () => json(200, { items: [agent] }),
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "done", "done", "pending"]),
    );
    expect(agent.id).toBe(AGENT_ID);
  });

  test("만들기만 하고 활성화하지 않은 에이전트는 아직이다", async () => {
    const server = agentServer();
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, { items: [owner, { ...owner, user_id: AGENT_ID }] }),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": server.routes["GET /v1/agents"],
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "done", "pending", "pending"]),
    );
  });

  test("관리 권한이 없으면 모르는 단계는 모른다고 적는다", async () => {
    const forbidden = () => apiError(403, "FORBIDDEN", "not allowed");
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
      "GET /v1/invites": forbidden,
      "GET /v1/agents": forbidden,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "unknown", "unknown", "pending"]),
    );
    expect(screen.getAllByText("확인할 수 없음")).toHaveLength(2);
  });
});
