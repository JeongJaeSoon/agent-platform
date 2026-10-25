import { describe, expect, test } from "bun:test";
import { json, me } from "../test-support/fake-api.ts";
import { appHarness, WAITING_SESSIONS } from "../test-support/render-app.tsx";

const { renderAt, screen } = await appHarness();

describe("/sessions/map", () => {
  test("the board waits for the open requests' count before its stand-in", async () => {
    const held: ((response: Response) => void)[] = [];
    renderAt("/sessions/map", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
      [WAITING_SESSIONS]: () =>
        new Promise<Response>((resolve) => {
          held.push(resolve);
        }),
    });
    await screen.findByText("불러오는 중입니다");
    expect(screen.queryByRole("heading", { name: "에이전트 지도" })).toBeNull();

    for (const answer of held)
      answer(json(200, { items: [], next_cursor: null }));
    await screen.findByRole("heading", { level: 1, name: "에이전트 지도" });
  });
});
