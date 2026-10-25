/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import {
  type ApiClient,
  type ApiClientOptions,
  createApiClient,
} from "@werft-ai/client";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import type { ReactNode } from "react";

const { renderHook, waitFor, act } = await setupDom();
const { AgentPlatformProvider } = await import("../../provider.tsx");
const { buildRunTree, runNodesOf, useSessionRunTree } = await import(
  "./index.ts"
);

const SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const T0 = Date.parse("2026-10-25T01:00:00.000Z");

type Event = readonly [event: string, data: unknown, seconds: number];

/** A held-open event stream; `push` writes frames in one read. */
function harness() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let seq = 0;
  let opened = 0;
  const frame = ([event, data, seconds]: Event) => {
    seq += 1;
    const envelope = {
      schema_version: 1,
      session_id: SESSION_ID,
      turn_id: "1",
      attempt_id: null,
      occurred_at: new Date(T0 + seconds * 1000).toISOString(),
      data,
    };
    return `id: ev_${seq.toString(36)}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`;
  };
  const fakeFetch = async (request: Request) => {
    opened += 1;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    request.signal.addEventListener("abort", () =>
      controller?.error(new DOMException("aborted", "AbortError")),
    );
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const client: ApiClient = createApiClient({
    baseUrl: "https://console.test",
    fetch: fakeFetch as unknown as NonNullable<ApiClientOptions["fetch"]>,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AgentPlatformProvider client={client} locale="ko" renderLink={() => null}>
      {children}
    </AgentPlatformProvider>
  );
  return {
    wrapper,
    push: (events: readonly Event[]) =>
      controller?.enqueue(encoder.encode(events.map(frame).join(""))),
    opened: () => opened,
  };
}

const use = (id: string, name: string, parent: string | null, s: number) =>
  [
    "tool_use",
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name,
            input: { subagent_type: "Explore", file_path: id },
          },
        ],
      },
      parent_tool_use_id: parent,
    },
    s,
  ] as const;
const done = (id: string, s: number) =>
  ["tool_result", { tool_use_id: id, content: "ok" }, s] as const;

describe("useSessionRunTree", () => {
  test("a session past 200 events keeps its subagent under the call that spawned it", async () => {
    // The Task call comes first; its subagent's 300 calls follow.
    const events: Event[] = [use("task-1", "Task", null, 0)];
    for (let i = 0; i < 300; i += 1) {
      events.push(use(`read-${i}`, "Read", "task-1", 1 + i));
      events.push(done(`read-${i}`, 1.5 + i));
    }
    const h = harness();
    const hook = renderHook(() => useSessionRunTree(SESSION_ID), {
      wrapper: h.wrapper,
    });
    await waitFor(() => expect(hook.result.current.state).toBe("open"));
    act(() => {
      h.push(events);
    });
    await waitFor(() => expect(hook.result.current.tree?.tools).toBe(301));

    const tree = hook.result.current.tree;
    expect(tree?.detached).toEqual([]);
    expect(runNodesOf(tree as never).map((node) => node.id)).toEqual([
      "root",
      "task-1",
    ]);
    expect(h.opened()).toBe(1);

    // What the 200-event window of useSessionEvents would have drawn.
    const window = events.slice(-200).map((event, i) => ({
      id: `ev_${i}`,
      occurredAt: new Date(T0 + event[2] * 1000).toISOString(),
      turnId: null,
      payload: { event: event[0], data: event[1] } as never,
    }));
    expect(buildRunTree(window).detached.map((run) => run.id)).toEqual([
      "task-1",
    ]);
  });

  test("no session, no stream", () => {
    const h = harness();
    const hook = renderHook(() => useSessionRunTree(null), {
      wrapper: h.wrapper,
    });
    expect(hook.result.current.tree).toBeNull();
    expect(h.opened()).toBe(0);
  });
});
