import { describe, expect, test } from "bun:test";
import { json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

describe("/sessions/map", () => {
  test("until the list comes, the loading screen stands in for the board", async () => {
    const held: ((response: Response) => void)[] = [];
    const { api } = renderAt("/sessions/map", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": () =>
        new Promise<Response>((resolve) => {
          held.push(resolve);
        }),
    });
    // The route's own pending screen says the same; the screen has to be up.
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.path === "/v1/sessions" && call.search === "",
        ),
      ).toBe(true),
    );
    await screen.findByText("불러오는 중입니다");
    expect(screen.queryByRole("heading", { name: "에이전트 지도" })).toBeNull();

    for (const answer of held)
      answer(json(200, { items: [], next_cursor: null }));
    await screen.findByRole("heading", { level: 1, name: "에이전트 지도" });
  });
});
