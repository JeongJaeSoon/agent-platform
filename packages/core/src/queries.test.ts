import { expect, test } from "bun:test";
import type { ApiClient } from "@werft-ai/client";
import * as queries from "./index.ts";

// Pins every key and option a factory hands the cache, and the request its
// query function makes, so moving the factories cannot change them.

function recordingClient() {
  const calls: unknown[][] = [];
  const client = {
    GET: (...args: unknown[]) => {
      calls.push(args);
      // An empty last page, so a query that reads every page stops.
      return Promise.resolve({
        data: { items: [], next_cursor: null },
        response: new Response(null),
      });
    },
  } as unknown as ApiClient;
  return { client, calls };
}

test("query keys", () => {
  expect({
    ...queries.queryKeys,
    agent: queries.queryKeys.agent("id-1"),
    agentAdmins: queries.queryKeys.agentAdmins("id-1"),
    team: queries.queryKeys.team("id-1"),
    session: queries.queryKeys.session("id-1"),
    sessionUsage: queries.queryKeys.sessionUsage("id-1"),
    pendingRequests: queries.queryKeys.pendingRequests("id-1"),
  }).toMatchSnapshot();
});

test("query options and the request each query makes", async () => {
  const factories = Object.entries(queries as Record<string, unknown>).filter(
    (entry): entry is [string, (client: ApiClient, id: string) => object] =>
      typeof entry[1] === "function" && entry[0].endsWith("Query"),
  );
  expect(factories.length).toBe(20);
  const out: Record<string, unknown> = {};
  for (const [name, factory] of factories.sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const { client, calls } = recordingClient();
    const { queryFn, ...options } = factory(client, "id-1") as {
      queryFn: (context: { pageParam: null }) => Promise<unknown>;
    };
    // The first page of a paged list; other queries take no page.
    await queryFn({ pageParam: null });
    out[name] = { options, calls };
  }
  expect(out).toMatchSnapshot();
});

test("the session list asks for the next page by the last page's cursor", async () => {
  const { client, calls } = recordingClient();
  const { queryFn, getNextPageParam } = queries.sessionsQuery(client);
  await queryFn({ pageParam: "cursor-2" } as Parameters<typeof queryFn>[0]);
  expect(calls).toEqual([
    ["/v1/sessions", { params: { query: { cursor: "cursor-2" } } }],
  ]);
  const page = { items: [], next_cursor: "cursor-3" };
  expect(getNextPageParam(page, [page], null, [null])).toBe("cursor-3");
});

test("the agent list reads every page, 100 at a time, and hands back all of them", async () => {
  const pages: Record<
    string,
    { items: { id: string }[]; next_cursor: string | null }
  > = {
    first: { items: [{ id: "a" }, { id: "b" }], next_cursor: "c2" },
    c2: { items: [{ id: "c" }], next_cursor: "c3" },
    c3: { items: [], next_cursor: null },
  };
  const calls: unknown[] = [];
  const client = {
    GET: (_path: string, init: { params: { query: { cursor?: string } } }) => {
      calls.push(init.params.query);
      const data = pages[init.params.query.cursor ?? "first"];
      return Promise.resolve({ data, response: new Response(null) });
    },
  } as unknown as ApiClient;
  const { queryFn } = queries.agentsQuery(client);
  expect(await queryFn({} as Parameters<typeof queryFn>[0])).toEqual({
    items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    next_cursor: null,
  });
  expect(calls).toEqual([
    { limit: 100 },
    { cursor: "c2", limit: 100 },
    { cursor: "c3", limit: 100 },
  ]);
});
