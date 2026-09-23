import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  PENDING_SETTLEMENTS_MAX,
  type PendingControlRequest,
  type PendingControlResponse,
  type PostSessionAnswerRequest,
  pendingControlRequestSchema,
  type RegisterPendingRequest,
  type RegisterPendingResponse,
  type SessionEventPayload,
  type WorkerScope,
} from "@agent-platform/contracts";
import type { PermissionRequest } from "@agent-platform/runtime-core";

import { FakeWorkerGateway } from "./fake-gateway.ts";
import { WorkerGatewayRequestError } from "./gateway-client.ts";
import {
  PendingRequestRegistry,
  type PendingRequestsOptions,
  QUESTION_TOOL,
} from "./pending-requests.ts";

const scope: WorkerScope = {
  session_id: "11111111-1111-4111-8111-111111111111",
  turn_id: "1",
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};

async function waitFor(check: () => boolean, what: string) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
}

function registry(
  options: Partial<PendingRequestsOptions> & { timeoutMs?: number } = {},
) {
  const gateway = new FakeWorkerGateway();
  // What the gateway would have written to the stream: a question event for
  // each registration that landed.
  const published: SessionEventPayload[] = [];
  const lost: unknown[] = [];
  const target = options.gateway ?? gateway;
  const instance = new PendingRequestRegistry({
    eventsStored: async () => {},
    scope: () => scope,
    timeoutMs: 30_000,
    pollIntervalMs: 1,
    onOwnershipLost: (error) => lost.push(error),
    ...options,
    gateway: {
      async registerPending(request) {
        const response = await target.registerPending(request);
        // Once per row: a replay writes nothing, as with the real gateway.
        const seen = published.some(
          (event) =>
            event.event === "question" &&
            event.data.request_id === request.request_id,
        );
        if (request.announce !== undefined && !seen) {
          published.push({
            event: "question",
            data: {
              request_id: request.request_id,
              tool_use_id: request.announce.tool_use_id,
              kind: request.request.kind,
              tool: request.announce.tool,
              input:
                request.request.kind === "permission"
                  ? request.request.input
                  : { questions: request.request.questions },
            },
          });
        }
        return response;
      },
      pendingControl: (request) => target.pendingControl(request),
    },
  });
  // The id the worker minted for the callback the engine raised as this
  // tool use, once its question event is out.
  const idFor = async (sdkRequestId: string) => {
    const toolUseId = `toolu_${sdkRequestId}`;
    const find = () =>
      published.find(
        (event) =>
          event.event === "question" && event.data.tool_use_id === toolUseId,
      );
    await waitFor(() => find() !== undefined, `the ${toolUseId} event`);
    const event = find();
    return event?.event === "question" ? event.data.request_id : "";
  };
  return {
    gateway,
    lost,
    published,
    registry: instance,
    idFor,
    // Answers the callback the engine knows as `request_id`.
    async answer(answer: PostSessionAnswerRequest) {
      const requestId = await idFor(answer.request_id);
      gateway.answer({ ...answer, request_id: requestId });
      return requestId;
    },
  };
}

function permission(requestId: string, command = "ls"): PermissionRequest {
  return {
    input: { command },
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
  test("registers before publishing, under an id of its own and the raw arguments' hash", async () => {
    const harness = registry();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const request = permission("req-allow", `curl -H 'x-api-key: ${secret}'`);
    const decision = harness.registry.request(request);
    const requestId = await harness.idFor("req-allow");

    expect(requestId).toMatch(/^req_[0-9a-f-]{36}$/);
    const [registration] = harness.gateway.registered();
    expect(registration?.request_id).toBe(requestId);
    expect(registration?.turn_id).toBe("1");
    expect(registration?.input_hash).toBe(
      createHash("sha256")
        .update(canonicalJson({ tool: "Bash", input: request.input }))
        .digest("hex"),
    );
    // What clients see is the redacted copy; the hash is not.
    expect(JSON.stringify(registration?.request)).not.toContain(secret);
    // The gateway writes the question event, so it is told what that event
    // needs beyond the request.
    expect(registration?.announce).toEqual({
      tool_use_id: "toolu_req-allow",
      tool: "Bash",
    });
    expect(harness.gateway.calls.indexOf("registerPending")).toBeGreaterThan(
      -1,
    );
    const event = harness.published[0];
    expect(event?.event === "question" ? event.data : null).toMatchObject({
      request_id: requestId,
      kind: "permission",
      tool: "Bash",
      tool_use_id: "toolu_req-allow",
    });
    expect(harness.registry.outstanding).toBe(1);

    await harness.answer({
      request_id: "req-allow",
      kind: "permission",
      decision: "allow",
    });
    expect(await decision).toEqual({ behavior: "allow" });
    expect(harness.registry.outstanding).toBe(0);
    await waitFor(() => harness.gateway.settled.length === 1, "settlement");
    expect(harness.gateway.settled).toEqual([
      { request_id: requestId, outcome: "answered" },
    ]);
  });

  test("registers only once the events before the callback are stored", async () => {
    let stored: (() => void) | undefined;
    const harness = registry({
      eventsStored: () =>
        new Promise<void>((resolve) => {
          stored = resolve;
        }),
    });
    const decision = harness.registry.request(permission("req-ordered"));
    await waitFor(() => stored !== undefined, "the barrier");
    await Bun.sleep(5);
    // The gateway writes the question as it registers, so registering now
    // could put it ahead of the tool call still in the publisher.
    expect(harness.gateway.calls).not.toContain("registerPending");
    stored?.();
    await harness.idFor("req-ordered");
    harness.registry.cancelAll("done");
    await decision;
  });

  test("denies without registering when the events before it cannot be stored", async () => {
    const harness = registry({
      eventsStored: async () => {
        throw new Error("owner lost");
      },
    });
    const decision = await harness.registry.request(permission("req-broken"));

    expect(decision.behavior).toBe("deny");
    expect(decision.behavior === "deny" ? decision.message : "").toContain(
      "owner lost",
    );
    expect(harness.gateway.calls).not.toContain("registerPending");
    await harness.registry.flush(100);
    // There is no row, so there is nothing to settle.
    expect(harness.gateway.settled).toEqual([]);
  });

  test("mints a new id for every callback, even when the engine repeats its own", async () => {
    const harness = registry();
    const first = harness.registry.request(permission("req-same"));
    const firstId = await harness.idFor("req-same");
    harness.registry.cancelAll("next");
    await first;
    harness.published.length = 0;
    const second = harness.registry.request(permission("req-same"));
    const secondId = await harness.idFor("req-same");
    expect(secondId).not.toBe(firstId);
    harness.registry.cancelAll("done");
    await second;
  });

  test("passes a denial's reason to the callback", async () => {
    const harness = registry();
    const decision = harness.registry.request(permission("req-deny"));
    await harness.answer({
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
    await harness.idFor("req-question");

    const [registration] = harness.gateway.registered();
    expect(registration?.request).toEqual({
      kind: "question",
      questions: [
        {
          question_id: "q0",
          prompt: "Which environment?",
          options: [
            { option_id: "q0o0", label: "staging" },
            { option_id: "q0o1", label: "production" },
          ],
          multi_select: false,
          allow_free_text: true,
        },
      ],
    });

    await harness.answer({
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
    await harness.answer({
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
    const requestId = await harness.answer({
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
    // Dropped, not delivered: the receipt must not read as succeeded.
    await waitFor(() => harness.gateway.settled.length === 1, "settlement");
    expect(harness.gateway.settled).toEqual([
      { request_id: requestId, outcome: "cancelled" },
    ]);
  });

  test("refuses an answer given for other arguments than the callback's", async () => {
    const harness = registry();
    const decision = harness.registry.request(permission("req-swapped"));
    const requestId = await harness.idFor("req-swapped");
    const [registration] = harness.gateway.registered();
    // A registration under the same id with different arguments, as a
    // collision would produce.
    harness.gateway.registrations.unshift({
      ...(registration as RegisterPendingRequest),
      input_hash: "f".repeat(64),
    });
    harness.gateway.answer({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });

    expect(await decision).toEqual({
      behavior: "deny",
      message: "The answer was given for different tool arguments",
    });
  });

  test("denies what the gateway will not take, and retries what it merely could not", async () => {
    let attempts = 0;
    const flaky: PendingRequestsOptions["gateway"] = {
      async registerPending(): Promise<RegisterPendingResponse> {
        attempts += 1;
        if (attempts === 1) {
          throw new WorkerGatewayRequestError(0, null, "socket closed", true);
        }
        throw new WorkerGatewayRequestError(
          404,
          "NOT_FOUND",
          "This gateway does not serve pending requests",
          false,
        );
      },
      async pendingControl(): Promise<PendingControlResponse> {
        return { control: null, answers: [] };
      },
    };
    const harness = registry({ gateway: flaky });

    const decision = await harness.registry.request(permission("req-refused"));

    expect(attempts).toBe(2);
    expect(decision.behavior).toBe("deny");
    expect(decision.behavior === "deny" ? decision.message : "").toContain(
      "does not serve pending requests",
    );
    // Nobody was told about a request nobody could answer.
    expect(harness.published).toHaveLength(0);
  });

  test("gives up the session when registration learns it lost ownership", async () => {
    const gateway: PendingRequestsOptions["gateway"] = {
      async registerPending(): Promise<RegisterPendingResponse> {
        throw new WorkerGatewayRequestError(
          409,
          "STALE_EPOCH",
          "Another epoch owns this session",
          false,
        );
      },
      async pendingControl(): Promise<PendingControlResponse> {
        throw new WorkerGatewayRequestError(
          409,
          "STALE_EPOCH",
          "Another epoch owns this session",
          false,
        );
      },
    };
    const harness = registry({ gateway });

    const decision = await harness.registry.request(permission("req-owner"));

    expect(decision).toEqual({
      behavior: "deny",
      message: "This worker no longer owns the session",
    });
    expect(harness.lost.length).toBeGreaterThan(0);
  });

  test("holds several requests independently and answers them out of order", async () => {
    const harness = registry();
    const first = harness.registry.request(permission("req-1"));
    const second = harness.registry.request(permission("req-2", "pwd"));
    await harness.idFor("req-1");
    await harness.idFor("req-2");
    expect(harness.registry.outstanding).toBe(2);

    await harness.answer({
      request_id: "req-2",
      kind: "permission",
      decision: "allow",
    });
    expect(await second).toEqual({ behavior: "allow" });
    expect(harness.registry.outstanding).toBe(1);

    await harness.answer({
      request_id: "req-1",
      kind: "permission",
      decision: "deny",
      reason: "no",
    });
    expect(await first).toEqual({ behavior: "deny", message: "no" });
  });

  test("denies a request nobody answered before it expired, and says so", async () => {
    const harness = registry({ timeoutMs: 5 });
    const decision = await harness.registry.request(permission("req-late"));

    expect(decision.behavior).toBe("deny");
    expect(decision.behavior === "deny" ? decision.message : "").toContain(
      "No answer arrived",
    );
    await waitFor(() => harness.gateway.settled.length === 1, "settlement");
    expect(harness.gateway.settled[0]?.outcome).toBe("expired");
  });

  test("never waits longer than the gateway takes answers", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.registerPending = async (request) => ({
      request_id: request.request_id,
      expires_at: new Date(Date.now() + 5).toISOString(),
      expires_in_ms: 5,
    });
    const harness = registry({ gateway, timeoutMs: 60_000 });
    const started = Date.now();

    const decision = await harness.registry.request(permission("req-short"));

    expect(decision.behavior).toBe("deny");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("refuses an answer of the wrong kind rather than applying it", async () => {
    const harness = registry();
    const decision = harness.registry.request(permission("req-mixed"));
    await harness.answer({
      request_id: "req-mixed",
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o0"] }],
    });

    expect(await decision).toEqual({
      behavior: "deny",
      message: "A question answer cannot settle a permission request",
    });
  });

  test("denies everything still waiting when the run stops, and reports it", async () => {
    const harness = registry();
    const decision = harness.registry.request(permission("req-cancel"));
    const requestId = await harness.idFor("req-cancel");
    harness.registry.cancelAll("Worker is shutting down");

    expect(await decision).toEqual({
      behavior: "deny",
      message: "Worker is shutting down",
    });
    await harness.registry.flush(1_000);
    expect(harness.gateway.settled).toEqual([
      { request_id: requestId, outcome: "cancelled" },
    ]);
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

  test("reports an answer whose callback is already gone instead of dropping it", async () => {
    const harness = registry();
    const decision = harness.registry.request(permission("req-gone"));
    const requestId = await harness.idFor("req-gone");
    harness.registry.cancelAll("gone");
    await decision;
    await harness.registry.flush(1_000);
    harness.gateway.settled.length = 0;
    // An answer for it still reaches this worker (it was stored just before
    // the settlement landed); a live request keeps the poll going.
    harness.gateway.answer({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    const other = harness.registry.request(permission("req-other"));
    await waitFor(
      () => harness.gateway.settled.some((s) => s.request_id === requestId),
      "the stray answer's settlement",
    );
    expect(
      harness.gateway.settled.find((s) => s.request_id === requestId)?.outcome,
    ).toBe("cancelled");
    harness.registry.cancelAll("done");
    await other;
  });

  test("replays a registration whose reply was lost after its callback closed, then settles it", async () => {
    const gateway = new FakeWorkerGateway();
    const original = gateway.registerPending.bind(gateway);
    let calls = 0;
    let release: (() => void) | undefined;
    gateway.registerPending = async (request) => {
      calls += 1;
      if (calls === 1) {
        // The row commits only after the callback's settlement went out,
        // and the reply never makes it back.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await original(request);
        throw new WorkerGatewayRequestError(0, null, "socket closed", true);
      }
      return original(request);
    };
    const harness = registry({ gateway });
    const controller = new AbortController();
    const decision = harness.registry.request({
      ...permission("req-lost"),
      signal: controller.signal,
    });
    await waitFor(() => release !== undefined, "the held registration");
    controller.abort();
    expect((await decision).behavior).toBe("deny");
    await waitFor(() => harness.registry.outstanding === 0, "the close");
    expect(gateway.settled).toEqual([]);
    release?.();
    await harness.registry.flush(1_000);

    expect(calls).toBe(2);
    const requestId = gateway.registrations[0]?.request_id ?? "";
    expect(gateway.settled).toEqual([
      { request_id: requestId, outcome: "cancelled" },
    ]);
    // The row did commit, and the gateway wrote its question with it; the
    // settlement is what closes it for whoever saw that.
    expect(harness.published).toHaveLength(1);
  });

  test("stops retrying a registration of unknown outcome once stopped", async () => {
    let calls = 0;
    const down: PendingRequestsOptions["gateway"] = {
      async registerPending(): Promise<RegisterPendingResponse> {
        calls += 1;
        throw new WorkerGatewayRequestError(0, null, "socket closed", true);
      },
      async pendingControl(): Promise<PendingControlResponse> {
        throw new WorkerGatewayRequestError(0, null, "socket closed", true);
      },
    };
    const harness = registry({ gateway: down });
    const decision = harness.registry.request(permission("req-down"));
    await waitFor(() => calls > 0, "the first registration");
    harness.registry.cancelAll("drain");
    await decision;
    // The callback is gone but the row may exist: the retries go on.
    await waitFor(() => calls > 2, "the retries after the close");
    harness.registry.stop();
    await harness.registry.flush(50);
    const settled = calls;
    await Bun.sleep(50);
    expect(calls).toBe(settled);
    expect(
      (await harness.registry.request(permission("req-late"))).behavior,
    ).toBe("deny");
  });

  test("a forced poll picks up an answer for a request this worker no longer holds", async () => {
    const harness = registry();
    const decision = harness.registry.request(permission("req-orphan"));
    const requestId = await harness.idFor("req-orphan");
    harness.registry.cancelAll("gone");
    await decision;
    await harness.registry.flush(1_000);
    // The gateway lost the settlement's effect; only its heartbeat says an
    // answer is waiting.
    harness.gateway.settled.length = 0;
    harness.gateway.answer({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    harness.registry.poll();
    expect(harness.gateway.settled).toEqual([]);
    harness.registry.poll(true);
    await waitFor(
      () => harness.gateway.settled.length > 0,
      "the orphan's settlement",
    );
    expect(harness.gateway.settled).toEqual([
      { request_id: requestId, outcome: "cancelled" },
    ]);
  });

  test("keeps a settlement made while a poll carrying others is in flight", async () => {
    const seen: PendingControlRequest[] = [];
    let release: (() => void) | undefined;
    const gateway = new FakeWorkerGateway();
    const original = gateway.pendingControl.bind(gateway);
    gateway.pendingControl = async (request) => {
      seen.push(request);
      if (seen.length === 1 && release === undefined) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(request);
    };
    const harness = registry({ gateway });
    const first = harness.registry.request(permission("req-x"));
    const second = harness.registry.request(permission("req-y", "pwd"));
    const x = await harness.idFor("req-x");
    const y = await harness.idFor("req-y");
    await waitFor(() => release !== undefined, "the held poll");
    harness.registry.cancelAll("stop");
    await first;
    await second;
    release?.();
    await harness.registry.flush(1_000);

    expect(gateway.settled.map((s) => s.request_id).sort()).toEqual(
      [x, y].sort(),
    );
  });

  test("never replays an answer it already consumed", async () => {
    const harness = registry();
    const first = harness.registry.request(permission("req-a"));
    await harness.answer({
      request_id: "req-a",
      kind: "permission",
      decision: "allow",
    });
    await first;

    const polls: number[] = [];
    const original = harness.gateway.pendingControl.bind(harness.gateway);
    harness.gateway.pendingControl = async (request) => {
      polls.push(request.answers_after);
      return original(request);
    };
    const second = harness.registry.request(permission("req-b", "pwd"));
    await harness.idFor("req-b");
    expect(harness.registry.outstanding).toBe(1);
    await harness.answer({
      request_id: "req-b",
      kind: "permission",
      decision: "allow",
    });
    expect(await second).toEqual({ behavior: "allow" });
    // The second poll cycle starts past the answer the first request consumed.
    expect(polls.every((after) => after >= 1)).toBe(true);
  });

  test("sends a settlement backlog larger than one call carries, in batches", async () => {
    const gateway = new FakeWorkerGateway();
    const original = gateway.pendingControl.bind(gateway);
    const sizes: number[] = [];
    // The transport the real route has: a body over the cap is a 400.
    gateway.pendingControl = async (request) => {
      if (!pendingControlRequestSchema.safeParse(request).success) {
        throw new WorkerGatewayRequestError(
          400,
          "BAD_REQUEST",
          "invalid",
          false,
        );
      }
      sizes.push(request.settled?.length ?? 0);
      return original(request);
    };
    const harness = registry({ gateway });
    const count = PENDING_SETTLEMENTS_MAX + 1;
    const decisions = Array.from({ length: count }, (_, index) =>
      harness.registry.request(
        permission(`req-many-${index}`, `echo ${index}`),
      ),
    );
    await waitFor(
      () => gateway.registered().length === count,
      "every registration",
    );
    harness.registry.cancelAll("stop");
    await Promise.all(decisions);
    await harness.registry.flush(2_000);

    expect(gateway.settled).toHaveLength(count);
    expect(Math.max(...sizes)).toBe(PENDING_SETTLEMENTS_MAX);
  });
});
