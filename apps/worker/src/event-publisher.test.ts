import { describe, expect, test } from "bun:test";
import type {
  AppendEventsRequest,
  AppendEventsResponse,
  SessionEvent,
  WorkerScope,
} from "@agent-platform/contracts";
import { WorkerGatewayRequestError } from "@agent-platform/runtime-core";

import { EventPublisher } from "./event-publisher.ts";

const scope: WorkerScope = {
  session_id: "11111111-1111-4111-8111-111111111111",
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};

function systemEvent(id: string): SessionEvent {
  return { id, event: "system", data: { type: "system", subtype: id } };
}

function publisher(
  appendEvents: (request: AppendEventsRequest) => Promise<AppendEventsResponse>,
  turnId: string | null = "1",
) {
  const batches: AppendEventsRequest[] = [];
  const instance = new EventPublisher({
    gateway: {
      appendEvents: (request) => {
        batches.push(request);
        return appendEvents(request);
      },
    },
    scope: () => ({ ...scope, turn_id: turnId }),
    retryDelayMs: 1,
  });
  return { batches, publisher: instance };
}

function accepted(request: AppendEventsRequest): AppendEventsResponse {
  const last = request.events.at(-1)?.source_sequence ?? 0;
  return { accepted_through: last, cursor: `cursor-${last}` };
}

function toolUseEvent(toolUseId: string): SessionEvent {
  return {
    id: toolUseId,
    event: "tool_use",
    data: {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: {} }],
      },
      parent_tool_use_id: null,
    },
  };
}

describe("EventPublisher", () => {
  test("lets a permission callback wait until the frame carrying its tool call is stored", async () => {
    let release: (() => void) | undefined;
    const { publisher: events } = publisher(async (request) => {
      if (request.events.some((event) => event.event === "tool_use")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return accepted(request);
    });
    let stored = false;
    const waiting = events.toolUseStored("toolu_1", 5_000).then(() => {
      stored = true;
    });
    events.publish([systemEvent("a"), toolUseEvent("toolu_other")], "1");
    await Bun.sleep(5);
    expect(stored).toBe(false);
    release?.();
    events.publish([toolUseEvent("toolu_1")], "1");
    // Numbered is not enough: it has to be stored.
    await Bun.sleep(5);
    expect(stored).toBe(false);
    release?.();
    await waiting;
    expect(stored).toBe(true);
  });

  test("a tool call answers one wait, and a wait that runs out or a failed stream rejects", async () => {
    const { publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    events.publish([toolUseEvent("toolu_1")], "1");
    await events.toolUseStored("toolu_1", 5_000);
    // The engine used the id again: this wait is for a frame not seen yet.
    await expect(events.toolUseStored("toolu_1", 30)).rejects.toThrow(
      "did not reach the event stream within 30ms",
    );

    const failing = publisher(async () => {
      throw new WorkerGatewayRequestError(409, "STALE_EPOCH", "fenced", false);
    }).publisher;
    const waiting = failing.toolUseStored("toolu_2", 5_000);
    failing.publish([toolUseEvent("toolu_2")], "1");
    await expect(waiting).rejects.toThrow("fenced");
    // A call stored before the stream failed does not let a request through.
    events.publish([toolUseEvent("toolu_3")], "1");
    await events.idle();
    events.abandon("owner lost");
    await expect(events.toolUseStored("toolu_3", 5_000)).rejects.toThrow(
      "abandoned",
    );
  });

  test("numbers the attempt's stream from one and keeps frame order", async () => {
    const { batches, publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    events.publish([systemEvent("a"), systemEvent("b")], "1");
    events.publish([systemEvent("c")], "1");
    await events.idle();

    expect(
      batches.flatMap((batch) =>
        batch.events.map((event) => event.source_sequence),
      ),
    ).toEqual([1, 2, 3]);
    expect(events.acceptedThrough).toBe(3);
  });

  test("never mixes two turns into one batch", async () => {
    const { batches, publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    // Both are queued before the first append resolves, so a publisher that
    // batched by size alone would put them in one request.
    events.publish([systemEvent("a")], "1");
    events.publish([systemEvent("b")], "2");
    await events.idle();

    expect(batches.map((batch) => batch.turn_id)).toEqual(["1", "2"]);
  });

  test("replays the same batch key after a retryable failure", async () => {
    let attempts = 0;
    const { batches, publisher: events } = publisher(async (request) => {
      attempts += 1;
      if (attempts === 1) {
        throw new WorkerGatewayRequestError(503, null, "gateway down", true);
      }
      return accepted(request);
    });
    events.publish([systemEvent("a")], "1");
    await events.idle();

    expect(attempts).toBe(2);
    expect(batches[0]?.batch_key).toBe(batches[1]?.batch_key);
    expect(batches[1]?.events[0]?.source_sequence).toBe(1);
  });

  test("surfaces a fenced-out write to whoever waits for the tail", async () => {
    const { publisher: events } = publisher(async () => {
      throw new WorkerGatewayRequestError(
        409,
        "LEASE_EXPIRED",
        "lease expired",
        false,
      );
    });
    events.publish([systemEvent("a")], "1");

    await expect(events.idle()).rejects.toThrow("lease expired");
  });

  test("drops the undelivered tail once the attempt is abandoned", async () => {
    const { batches, publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    events.abandon("ownership lost");
    events.publish([systemEvent("a")], "1");

    expect(batches).toEqual([]);
    await expect(events.idle()).rejects.toThrow("ownership lost");
  });

  test("holds back what was published past a cut until it is released", async () => {
    const { batches, publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    events.publish([systemEvent("a"), systemEvent("b")], "1");
    expect(events.hold()).toBe(2);
    events.publish([systemEvent("late")], null);
    await events.idle();

    // Idle means durable up to the cut; the late event is still waiting.
    expect(events.acceptedThrough).toBe(2);
    expect(batches.flatMap((batch) => batch.events)).toHaveLength(2);
    // A second hold does not move the cut.
    expect(events.hold()).toBe(2);

    events.release();
    await events.idle();
    expect(events.acceptedThrough).toBe(3);
    expect(batches.at(-1)?.turn_id).toBeNull();
  });

  test("strips the frame cursor that is not this stream's", async () => {
    const { batches, publisher: events } = publisher(async (request) =>
      accepted(request),
    );
    events.publish([systemEvent("sdk:0:1")], "1");
    await events.idle();

    expect(batches[0]?.events[0]).not.toHaveProperty("id");
  });
});
