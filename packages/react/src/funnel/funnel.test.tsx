import { describe, expect, test } from "bun:test";
import type { ApiClient } from "@agent-platform/client";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentPlatformProvider,
  createFunnel,
  type FunnelRouter,
  type Locale,
  type StepperOptions,
  useStepper,
} from "../index.ts";

// A server render runs the guards against the stored step without a DOM;
// moving between steps and the effects that rewrite history are the web
// adapter's tests, against a real router.

type AnyState = { step: string; context: Record<string, unknown> };
let stored: AnyState[] | undefined;
const replaced: AnyState[] = [];

const memoryRouter: FunnelRouter = ({ initialState }) => {
  const history = stored ?? [initialState];
  return {
    history,
    currentIndex: history.length - 1,
    push: () => {},
    replace: (state) => {
      replaced.push(state);
    },
    go: () => {},
    cleanup: () => {},
  };
};
const useFunnel = createFunnel(memoryRouter);

type Steps = {
  name: { name?: string };
  role: { name: string; role?: string };
};

function Flow() {
  const funnel = useFunnel<Steps>({
    id: "new-agent",
    initial: { step: "name", context: {} },
    steps: {
      name: {
        guard: (data): data is Steps["name"] => typeof data === "object",
      },
      role: {
        guard: (data): data is Steps["role"] =>
          typeof (data as { name?: unknown }).name === "string",
      },
    },
  });
  return (
    <>
      {`${funnel.step} ${Object.values(funnel.context).join(",")} reset=${funnel.reset}`}
    </>
  );
}

describe("useFunnel", () => {
  test("a stored step its guard accepts comes back as it was", () => {
    stored = [
      { step: "name", context: {} },
      { step: "role", context: { name: "triage" } },
    ];
    expect(renderToStaticMarkup(<Flow />)).toBe("role triage reset=false");
  });

  test("a stored step its guard refuses restarts the flow and says so", () => {
    // Input saved before a deploy changed the step's shape.
    stored = [
      { step: "name", context: {} },
      { step: "role", context: { label: "triage" } },
    ];
    expect(renderToStaticMarkup(<Flow />)).toBe("name  reset=true");
  });

  test("without a stored step the flow starts at its initial step", () => {
    stored = undefined;
    expect(renderToStaticMarkup(<Flow />)).toBe("name  reset=false");
    // Effects do not run on the server: nothing was rewritten.
    expect(replaced).toEqual([]);
  });
});

const STEPS = [
  { id: "name", label: "이름" },
  { id: "role", label: "하는 일" },
  { id: "release", label: "배포 판" },
];

function stepper(options: StepperOptions, locale: Locale = "ko") {
  let state: ReturnType<typeof useStepper> | undefined;
  function Probe() {
    state = useStepper(options);
    return null;
  }
  const wrap = (node: ReactNode) => (
    <AgentPlatformProvider
      client={{} as ApiClient}
      locale={locale}
      renderLink={({ children }) => children}
    >
      {node}
    </AgentPlatformProvider>
  );
  renderToStaticMarkup(wrap(<Probe />));
  if (!state) throw new Error("useStepper did not run");
  return state;
}

describe("useStepper", () => {
  test("finished steps and the current one are open, later ones are not", () => {
    const state = stepper({ steps: STEPS, currentStepId: "role" });
    expect(state.steps.map(({ id, disabled }) => [id, disabled])).toEqual([
      ["name", false],
      ["role", false],
      ["release", true],
    ]);
    expect(state.currentStepId).toBe("role");
    expect(state.onStepSelect).toBeUndefined();
  });

  test("picking the current step again does nothing", () => {
    const picked: string[] = [];
    const state = stepper({
      steps: STEPS,
      currentStepId: "role",
      onStepSelect: (id) => picked.push(id),
    });
    state.onStepSelect?.("role");
    state.onStepSelect?.("name");
    expect(picked).toEqual(["name"]);
  });

  test("the finished-step wording follows the locale", () => {
    const options = { steps: STEPS, currentStepId: "role" };
    expect(stepper(options, "ko").completedLabel).toBe("완료");
    expect(stepper(options, "en").completedLabel).toBe("completed");
  });
});
