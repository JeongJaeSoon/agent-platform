import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer, CARD } from "../../test-support/fake-agents.ts";
import { apiError, json, me } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const DETAIL = `/agents/${AGENT_ID}`;
const PROFILE = "claude-coding-local";
const BINDINGS = `/v1/agents/${AGENT_ID}/credential-bindings`;

/** A server whose only version names these credentials. */
function serverNaming(...refs: string[]) {
  const server = agentServer();
  const first = server.versions[0];
  if (!first) throw new Error("agentServer starts with a version");
  server.versions[0] = {
    ...first,
    card: {
      ...CARD,
      capabilities: { ...CARD.capabilities, credential_refs: refs },
    },
  };
  return server;
}

const step = async () =>
  (await screen.findByRole("heading", { name: "자격 연결" })).closest(
    "section",
  ) as HTMLElement;

const posted = (api: { calls: { method: string; path: string }[] }) =>
  api.calls.filter((c) => c.method === "POST" && c.path === BINDINGS);

describe("자격 연결 단계", () => {
  test("카드가 쓰는 이름을 연결하고 해제한다", async () => {
    const server = serverNaming("github/app");
    const { api } = renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    const section = await step();

    const unbound = await within(section).findByRole("list", {
      name: "연결되지 않은 자격",
    });
    expect(unbound.textContent).toContain("github/app");
    expect(
      within(section).getByText("아직 연결된 자격이 없습니다."),
    ).toBeDefined();
    await user.click(
      within(section).getByRole("button", { name: "github/app 연결" }),
    );
    expect(
      await within(section).findByText("github/app을(를) 연결했습니다."),
    ).toBeDefined();
    expect(posted(api).map((c) => (c as { body?: unknown }).body)).toEqual([
      { credential_ref: "github/app" },
    ]);
    const bound = await within(section).findByRole("list", {
      name: "연결된 자격",
    });
    expect(bound.textContent).toContain("github/app");
    expect(bound.textContent).toContain("실행 중인 세션 0개");
    expect(
      within(section).queryByRole("list", { name: "연결되지 않은 자격" }),
    ).toBeNull();

    await user.click(
      within(section).getByRole("button", { name: "github/app 연결 해제" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("다음 세션부터 시작하지 못합니다");
    await user.click(within(dialog).getByRole("button", { name: "연결 해제" }));
    expect(
      await within(section).findByText("github/app의 연결을 해제했습니다."),
    ).toBeDefined();
    expect(
      api.calls.some(
        (c) =>
          c.method === "DELETE" &&
          c.path === `${BINDINGS}/${server.bindings[0]?.id}`,
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(
        within(section).getByRole("list", { name: "연결되지 않은 자격" })
          .textContent,
      ).toContain("github/app"),
    );
  });

  test("이름 칸에 값처럼 보이는 것을 넣으면 보내지 않고, 이름은 보낸다", async () => {
    const server = agentServer();
    const { api } = renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    const section = await step();
    const name = await within(section).findByLabelText("자격 이름");

    await user.type(name, "ghp_Secret Value");
    await user.click(within(section).getByRole("button", { name: "연결" }));
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(within(section).getByText(/이름 형식이 아닙니다/)).toBeDefined();
    expect(posted(api)).toEqual([]);

    await user.clear(name);
    await user.type(name, "slack:bot");
    await user.click(within(section).getByRole("button", { name: "연결" }));
    expect(
      await within(section).findByText("slack:bot을(를) 연결했습니다."),
    ).toBeDefined();
    expect((name as HTMLInputElement).value).toBe("");
  });

  test("목록이 거절되면 권한 사유를 보인다", async () => {
    const server = agentServer();
    renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      [`GET ${BINDINGS}`]: () =>
        apiError(403, "FORBIDDEN", "This principal does not hold it"),
    });
    const section = await step();
    expect((await within(section).findByText(/에이전트 관리/)).className).toBe(
      "web-guarded__reason",
    );
    expect(within(section).queryByLabelText("자격 이름")).toBeNull();
  });
});

describe("CREDENTIAL_UNBOUND 안내", () => {
  test("활성화가 거절되면 빠진 이름과 자격 연결로 가는 행동을 보이고, 연결 뒤 다시 활성화된다", async () => {
    const server = serverNaming("github/app", "slack:bot");
    const { api } = renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    await screen.findByLabelText("runtime profile");
    await user.click(screen.getByRole("button", { name: "release 만들기" }));
    const activate = await screen.findByRole("button", {
      name: `version 1 · ${PROFILE} 활성화`,
    });
    await user.click(activate);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "연결되지 않은 자격이 있어 활성화하지 못했습니다",
    );
    expect(alert.textContent).toContain("github/app, slack:bot");
    // Shown in the releases section, where the button was pressed.
    const releases = screen
      .getByRole("heading", { name: "release" })
      .closest("section") as HTMLElement;
    expect(releases.contains(alert)).toBe(true);
    expect(document.activeElement?.contains(alert)).toBe(true);

    await user.click(
      within(alert).getByRole("button", { name: "자격 연결로 가기" }),
    );
    const heading = screen.getByRole("heading", { name: "자격 연결" });
    expect(document.activeElement).toBe(heading);
    const section = await step();
    expect(
      within(section).getAllByText("활성화에 필요 · 연결 안 됨").length,
    ).toBe(2);

    await user.click(
      within(section).getByRole("button", { name: "github/app 연결" }),
    );
    await within(section).findByText("github/app을(를) 연결했습니다.");
    await user.click(
      within(section).getByRole("button", { name: "slack:bot 연결" }),
    );
    await within(section).findByText("slack:bot을(를) 연결했습니다.");

    await user.click(
      screen.getByRole("button", { name: `version 1 · ${PROFILE} 활성화` }),
    );
    expect(
      await screen.findByText(
        `활성화됐습니다 — 이제 새 세션은 version 1 · ${PROFILE}(으)로 시작합니다.`,
      ),
    ).toBeDefined();
    expect(
      screen.queryByText("연결되지 않은 자격이 있어 활성화하지 못했습니다"),
    ).toBeNull();
    expect(api.calls.filter((c) => c.path.endsWith("/activate")).length).toBe(
      2,
    );
  });

  test("details가 계약 모양이 아니어도 이름 없이 안내한다", async () => {
    const server = agentServer();
    renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      [`POST /v1/agents/${AGENT_ID}/activate`]: () =>
        apiError(409, "CREDENTIAL_UNBOUND", "unbound"),
    });
    const user = await setupUser();
    await screen.findByLabelText("runtime profile");
    await user.click(screen.getByRole("button", { name: "release 만들기" }));
    await user.click(
      await screen.findByRole("button", {
        name: `version 1 · ${PROFILE} 활성화`,
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "이 release가 쓰는 자격 중 연결되지 않은 것이 있습니다",
    );
    expect(
      within(alert).getByRole("button", { name: "자격 연결로 가기" }),
    ).toBeDefined();
  });

  test("이름 칸에 넣은 값은 화면 밖 query·mutation 캐시와 console에 남지 않는다", async () => {
    const SECRET = "ghp_SuperSecretValue0123";
    const logged: unknown[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        logged.push(...args);
      };
    }
    try {
      const server = serverNaming("github/app");
      const { api, services } = renderAt(DETAIL, {
        ...meOk,
        ...server.routes,
      });
      const user = await setupUser();
      const section = await step();
      await user.type(
        await within(section).findByLabelText("자격 이름"),
        SECRET,
      );
      await user.click(within(section).getByRole("button", { name: "연결" }));
      await user.click(
        within(section).getByRole("button", { name: "github/app 연결" }),
      );
      await within(section).findByText("github/app을(를) 연결했습니다.");

      expect(JSON.stringify(api.calls.map((c) => c.body))).not.toContain(
        SECRET,
      );
      const cached = [
        ...services.queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
        ...services.queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state.variables),
      ];
      expect(JSON.stringify(cached)).not.toContain(SECRET);
      expect(logged.some((arg) => String(arg).includes(SECRET))).toBe(false);
    } finally {
      methods.forEach((name, index) => {
        console[name] = originals[index] as (typeof console)[typeof name];
      });
    }
  });
});
