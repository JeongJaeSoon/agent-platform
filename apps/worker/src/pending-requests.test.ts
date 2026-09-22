import { describe, expect, test } from "bun:test";
import type {
  PendingControlResponse,
  PostSessionAnswerRequest,
  SessionEvent,
  WorkerScope,
} from "@agent-platform/contracts";
import type { PermissionRequest } from "@agent-platform/runtime-core";

import { WorkerGatewayRequestError } from "./gateway-client.ts";
import { PendingRequestRegistry, QUESTION_TOOL } from "./pending-requests.ts";

const scope: WorkerScope = {
  session_id: "11111111-1111-4111-8111-111111111111",
  turn_id: "1",
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};

function registry(options: { timeoutMs?: number } = {}) {
  const answers: Array<{ answer: PostSessionAnswerRequest; sequence: number }> =
    [];
  const published: SessionEvent[] = [];
  const polls: number[] = [];
  const instance = new PendingRequestRegistry({
    gateway: {
      async pendingControl(request): Promise<PendingControlResponse> {
        polls.push(request.answers_after);
        return {
          control: null,
          answers: answers.filter(
            (entry) => entry.sequence > request.answers_after,
          ),
        };
      },
    },
    publish: (event) => published.push(event),
    scope: () => scope,
    timeoutMs: options.timeoutMs ?? 30_000,
    pollIntervalMs: 1,
  });
  return {
    answers,
    polls,
    published,
    registry: instance,
    answer(answer: PostSessionAnswerRequest) {
      answers.push({ answer, sequence: answers.length + 1 });
    },
  };
}

function permission(requestId: string): PermissionRequest {
  return {
    input: { command: "ls" },
    requestId,
    signal: new AbortController().signal,
    tool: "Bash",
    toolUseId: `toolu_${requestId}`,
  };
}

function question(requestId: string): PermissionRequest {
  return {
    input: {
      questions: [
        {
          header: "deploy",
          question: "Which environment?",
          multiSelect: false,
          options: [
            { label: "staging", description: "the safe one" },
            { label: "production", description: "the other one" },
          ],
        },
      ],
    },
    requestId,
    signal: new AbortController().signal,
    tool: QUESTION_TOOL,
    toolUseId: `toolu_${requestId}`,
  };
}

describe("PendingRequestRegistry", () => {
  test("registers a permission as a question event and allows it once answered", async () => {
    const harness = registry();
    const decision = harness.registry.request(permission("req-allow"));
    await Bun.sleep(1);

    expect(harness.published).toHaveLength(1);
    const event = harness.published[0];
    expect(event?.event).toBe("question");
    expect(event?.event === "question" ? event.data : null).toMatchObject({
      request_id: "req-allow",
      kind: "permission",
      tool: "Bash",
      tool_use_id: "toolu_req-allow",
    });
    expect(harness.registry.outstanding).toBe(1);

    harness.answer({
      request_id: "req-allow",
      kind: "permission",
      decision: "allow",
    });
    expect(await decision).toEqual({ behavior: "allow" });
    expect(harness.registry.outstanding).toBe(0);
  });

  test("passes a denial's reason to the callback", async () => {
    const harness = registry();
    const decision = harness.registry.request(permission("req-deny"));
    harness.answer({
      request_id: "req-deny",
      kind: "permission",
      decision: "deny",
      reason: "Not on production",
    });

    expect(await decision).toEqual({
      behavior: "deny",
      message: "Not on production",
    });
  });

  test("turns a question answer into the input shape the SDK expects", async () => {
    const harness = registry();
    const decision = harness.registry.request(question("req-question"));
    await Bun.sleep(1);

    const event = harness.published[0];
    expect(event?.event === "question" ? event.data.kind : null).toBe(
      "question",
    );

    harness.answer({
      request_id: "req-question",
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o1"] }],
    });

    expect(await decision).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: expect.any(Array),
        answers: { "Which environment?": "production" },
      },
    });
  });

  test("carries free text through as the answer", async () => {
    const harness = registry();
    const decision = harness.registry.request(question("req-free"));
    harness.answer({
      request_id: "req-free",
      kind: "question",
      answers: [
        {
          question_id: "q0",
          selected_option_ids: [],
          free_text: "somewhere else",
        },
      ],
    });

    expect(await decision).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: expect.any(Array),
        answers: { "Which environment?": "somewhere else" },
      },
    });
  });

  test.each([
    [
      "names a question nobody asked",
      [{ question_id: "q9", selected_option_ids: ["q9o0"] }],
      "No question q9",
    ],
    [
      "names an option the question does not offer",
      [{ question_id: "q0", selected_option_ids: ["q0o7"] }],
      "no option q0o7",
    ],
    [
      "picks two options of a single-select question",
      [{ question_id: "q0", selected_option_ids: ["q0o0", "q0o1"] }],
      "takes one option",
    ],
    [
      "answers one question twice",
      [
        { question_id: "q0", selected_option_ids: ["q0o0"] },
        { question_id: "q0", selected_option_ids: ["q0o1"] },
      ],
      "answered twice",
    ],
    ["leaves the question unanswered", [], "q0 was not answered"],
  ] as const)("denies an answer that %s", async (_label, answers, message) => {
    const harness = registry();
    const decision = harness.registry.request(question("req-bad"));
    harness.answer({
      request_id: "req-bad",
      kind: "question",
      answers: answers.map((answer) => ({
        ...answer,
        selected_option_ids: [...answer.selected_option_ids],
      })),
    });

    const settled = await decision;
    expect(settled.behavior).toBe("deny");
    expect(settled.behavior === "deny" ? settled.message : "").toContain(
      message,
    );
  });

  test("denies at once while the gateway has no route to answer through", async () => {
    let polls = 0;
    const instance = new PendingRequestRegistry({
      gateway: {
        async pendingControl() {
          polls += 1;
          throw new WorkerGatewayRequestError(404, null, "no route", false);
        },
      },
      publish: () => {},
      scope: () => scope,
      timeoutMs: 30_000,
      pollIntervalMs: 1,
    });

    const first = await instance.request(permission("req-first"));
    const second = await instance.request(permission("req-second"));

    expect(first).toEqual({
      behavior: "deny",
      message: expect.stringContaining("94S-127"),
    });
    expect(second.behavior).toBe("deny");
    // Learned once: the second request does not ask again.
    expect(polls).toBe(1);
  });

  test("holds several requests independently and answers them out of order", async () => {
    const harness = registry();
    const first = harness.registry.request(permission("req-1"));
    const second = harness.registry.request(permission("req-2"));
    await Bun.sleep(1);
    expect(harness.registry.outstanding).toBe(2);

    harness.answer({
      request_id: "req-2",
      kind: "permission",
      decision: "allow",
    });
    expect(await second).toEqual({ behavior: "allow" });
    expect(harness.registry.outstanding).toBe(1);

    harness.answer({
      request_id: "req-1",
      kind: "permission",
      decision: "deny",
      reason: "no",
    });
    expect(await first).toEqual({ behavior: "deny", message: "no" });
  });

  test("denies a request nobody answered before it expired", async () => {
    const harness = registry({ timeoutMs: 5 });
    const decision = await harness.registry.request(permission("req-late"));

    expect(decision.behavior).toBe("deny");
    expect(decision.behavior === "deny" ? decision.message : "").toContain(
      "No answer arrived",
    );
  });

  test("refuses an answer of the wrong kind rather than applying it", async () => {
    const harness = registry();
    const decision = harness.registry.request(permission("req-mixed"));
    harness.answer({
      request_id: "req-mixed",
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o0"] }],
    });

    expect(await decision).toEqual({
      behavior: "deny",
      message: "A question answer cannot settle a permission request",
    });
  });

  test("denies everything still waiting when the run stops", async () => {
    const harness = registry();
    const decision = harness.registry.request(permission("req-cancel"));
    await Bun.sleep(1);
    harness.registry.cancelAll("Worker is shutting down");

    expect(await decision).toEqual({
      behavior: "deny",
      message: "Worker is shutting down",
    });
  });

  test("stops waiting when the engine aborts the callback", async () => {
    const harness = registry();
    const controller = new AbortController();
    const decision = harness.registry.request({
      ...permission("req-abort"),
      signal: controller.signal,
    });
    controller.abort();

    expect((await decision).behavior).toBe("deny");
  });

  test("never replays an answer it already consumed", async () => {
    const harness = registry();
    const first = harness.registry.request(permission("req-a"));
    harness.answer({
      request_id: "req-a",
      kind: "permission",
      decision: "allow",
    });
    await first;

    const second = harness.registry.request(permission("req-b"));
    await Bun.sleep(5);
    expect(harness.registry.outstanding).toBe(1);
    harness.answer({
      request_id: "req-b",
      kind: "permission",
      decision: "allow",
    });
    expect(await second).toEqual({ behavior: "allow" });
    // The second poll cycle starts past the answer the first request consumed.
    expect(harness.polls.some((after) => after >= 1)).toBe(true);
  });
});
