import { beforeEach, describe, expect, test } from "bun:test";
import type { ApiClient } from "@agent-platform/client";
import { setupDom, setupUser } from "@agent-platform/ui/test-support/dom";

// The DOM has to exist before the router and Testing Library load. The
// router runs on a browser history over happy-dom's window.history, so
// history.state, back and forward are the window's own; a reload is a new
// router reading the same window.
const testing = await setupDom();
const { render, waitFor, act } = testing;
// Testing Library's `screen` stays bound to the first file's document in a
// multi-file run; look the live body up on every query instead.
const screen = new Proxy(testing.screen, {
  get: (_target, key) => Reflect.get(testing.within(document.body), key),
});
const {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} = await import("@tanstack/react-router");
const { AgentPlatformProvider, useStepper } = await import(
  "@agent-platform/react"
);
const { Stepper } = await import("@agent-platform/ui");
const { I18nProvider } = await import("../i18n/i18n.tsx");
const { FunnelResetNotice, useFunnel } = await import("./tanstack-funnel.tsx");

type Steps = {
  name: { name?: string };
  role: { name: string; role?: string };
  done: { name: string; role: string };
};

const isObject = (data: unknown): data is Steps["name"] =>
  typeof data === "object" && data !== null;
const hasName = (data: unknown): data is Steps["role"] =>
  typeof (data as { name?: unknown }).name === "string";
const hasRole = (data: unknown): data is Steps["done"] =>
  hasName(data) && typeof (data as { role?: unknown }).role === "string";

const STEPS = [
  { id: "name", label: "이름" },
  { id: "role", label: "하는 일" },
  { id: "done", label: "끝" },
];

function Flow() {
  const funnel = useFunnel<Steps>({
    id: "new-agent",
    initial: { step: "name", context: {} },
    steps: {
      name: { guard: isObject },
      role: { guard: hasName },
      done: { guard: hasRole },
    },
  });
  const stepper = useStepper({
    steps: STEPS,
    currentStepId: funnel.step,
    onStepSelect: (id) => {
      const at = funnel.historySteps
        .map(({ step }): string => step)
        .lastIndexOf(id);
      if (at >= 0) void funnel.history.go(at - funnel.index);
    },
  });
  return (
    <>
      <FunnelResetNotice funnel={funnel} />
      <Stepper label="에이전트 만들기 단계" {...stepper} />
      <p data-testid="at">{`${funnel.step}:${JSON.stringify(funnel.context)}`}</p>
      <funnel.Render
        name={({ history }) => (
          <>
            <button
              type="button"
              onClick={() => history.push("role", { name: "triage" })}
            >
              next
            </button>
            <button
              type="button"
              // Skips the name: the role step's guard turns it away.
              onClick={() => history.push("role", {} as Steps["role"])}
            >
              skip
            </button>
          </>
        )}
        role={({ history }) => (
          <button
            type="button"
            onClick={() => history.push("done", { role: "support" })}
          >
            next
          </button>
        )}
        done={() => <p>finished</p>}
      />
    </>
  );
}

function mount() {
  const root = createRootRoute();
  const flow = createRoute({
    getParentRoute: () => root,
    path: "/flow",
    component: Flow,
  });
  const history = createBrowserHistory();
  const router = createRouter({
    routeTree: root.addChildren([flow]),
    history,
  });
  const view = render(
    <I18nProvider locale="ko">
      <AgentPlatformProvider
        client={{} as ApiClient}
        locale="ko"
        renderLink={({ children }) => children}
      >
        <RouterProvider router={router} />
      </AgentPlatformProvider>
    </I18nProvider>,
  );
  return { history, view };
}

const at = async (text: string) =>
  waitFor(() => expect(screen.getByTestId("at").textContent).toBe(text));

const stored = () =>
  (window.history.state as Record<string, unknown> | null)?.[
    "new-agent.histories"
  ];

// The router drops a history.state it did not write, so a stored entry
// carries its keys as a reload would find them.
const routerWritten = (state: Record<string, unknown>) => ({
  __TSR_index: 0,
  key: "stored",
  __TSR_key: "stored",
  ...state,
});

const RESET_TEXT =
  "이어 하던 입력이 지금 화면과 맞지 않아 첫 단계부터 다시 시작합니다.";

beforeEach(() => {
  window.history.replaceState(null, "", "/flow");
});

describe("the TanStack Router funnel adapter", () => {
  test("a step goes to the URL and its input to history.state", async () => {
    const user = await setupUser();
    mount();
    await at("name:{}");
    await user.click(screen.getByRole("button", { name: "next" }));
    await at('role:{"name":"triage"}');
    expect(window.location.search).toBe("?new-agent.step=role");
    expect(stored()).toEqual([
      { step: "name", context: {} },
      { step: "role", context: { name: "triage" } },
    ]);
  });

  test("back and forward bring each step back with its input", async () => {
    const user = await setupUser();
    const { history } = mount();
    await at("name:{}");
    await user.click(screen.getByRole("button", { name: "next" }));
    await at('role:{"name":"triage"}');
    await user.click(screen.getByRole("button", { name: "next" }));
    await at('done:{"name":"triage","role":"support"}');

    act(() => history.back());
    await at('role:{"name":"triage"}');
    act(() => history.back());
    await at("name:{}");
    act(() => history.forward());
    await at('role:{"name":"triage"}');
    expect(screen.queryByText(RESET_TEXT)).toBeNull();
  });

  test("a reload restores the step and its input from history.state", async () => {
    const user = await setupUser();
    const first = mount();
    await at("name:{}");
    await user.click(screen.getByRole("button", { name: "next" }));
    await user.click(await screen.findByRole("button", { name: "next" }));
    await at('done:{"name":"triage","role":"support"}');
    first.view.unmount();
    first.history.destroy();

    mount();
    await at('done:{"name":"triage","role":"support"}');
    expect(screen.getByText("finished")).toBeTruthy();
  });

  test("a finished step picked on the stepper goes back to it", async () => {
    const user = await setupUser();
    mount();
    await user.click(await screen.findByRole("button", { name: "next" }));
    await at('role:{"name":"triage"}');
    const steps = screen.getByRole("navigation", {
      name: "에이전트 만들기 단계",
    });
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toBe(
      "2하는 일",
    );
    // The finished step reads out as finished; the next one is out of reach.
    const finished = screen.getByRole("button", { name: /^이름\s*, 완료$/ });
    expect(
      (screen.getByRole("button", { name: "끝" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await user.click(finished);
    await at("name:{}");
  });
});

describe("a step guard that turns the input away", () => {
  test("stored input that no longer fits restarts the flow with a notice", async () => {
    // A reload after a deploy renamed the role step's field.
    window.history.replaceState(
      routerWritten({
        "new-agent.histories": [
          { step: "name", context: {} },
          { step: "role", context: { label: "triage" } },
        ],
      }),
      "",
      "/flow?new-agent.step=role",
    );
    const user = await setupUser();
    // What the live region held when it entered the page.
    const arrived: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element)
            for (const region of [
              ...(node.matches("[aria-live]") ? [node] : []),
              ...node.querySelectorAll("[aria-live]"),
            ])
              arrived.push(region.textContent ?? "");
    });
    watch.observe(document.body, { childList: true, subtree: true });
    mount();
    await at("name:{}");
    expect(await screen.findByText(RESET_TEXT)).toBeTruthy();
    watch.disconnect();
    // It arrived empty, so the text that followed is read out.
    expect(arrived).toEqual([""]);
    // The stale input is gone, so the next reload starts clean too.
    await waitFor(() =>
      expect((stored() as unknown[]).at(-1)).toEqual({
        step: "name",
        context: {},
      }),
    );
    expect(JSON.stringify(stored())).not.toContain("label");

    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByText(RESET_TEXT)).toBeNull();
  });

  test("a stored step the flow no longer has restarts it with a notice", async () => {
    window.history.replaceState(
      routerWritten({
        "new-agent.histories": [
          { step: "name", context: {} },
          { step: "review", context: { name: "triage" } },
        ],
      }),
      "",
      "/flow?new-agent.step=review",
    );
    mount();
    await at("name:{}");
    expect(await screen.findByText(RESET_TEXT)).toBeTruthy();
    await waitFor(() =>
      expect((stored() as unknown[]).at(-1)).toEqual({
        step: "name",
        context: {},
      }),
    );
  });

  test("a move its guard refuses lands on the first step with a notice", async () => {
    const user = await setupUser();
    mount();
    await at("name:{}");
    await user.click(screen.getByRole("button", { name: "skip" }));
    await at("name:{}");
    expect(await screen.findByText(RESET_TEXT)).toBeTruthy();
  });

  test("garbage in history.state is ignored, not rendered", async () => {
    window.history.replaceState(
      routerWritten({ "new-agent.histories": ["role", { step: 3 }] }),
      "",
      "/flow",
    );
    mount();
    await at("name:{}");
    expect(screen.queryByText(RESET_TEXT)).toBeNull();
  });
});
