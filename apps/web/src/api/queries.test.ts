import { expect, test } from "bun:test";
import type { ApiClient } from "./client.ts";
import * as queries from "./queries.ts";

// Pins every key and option a factory hands the cache, and the request its
// query function makes, so moving the factories cannot change them.

function recordingClient() {
  const calls: unknown[][] = [];
  const client = {
    GET: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ data: {}, response: new Response(null) });
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
  }).toMatchSnapshot();
});

test("query options and the request each query makes", async () => {
  const factories = Object.entries(queries).filter(
    (entry): entry is [string, (client: ApiClient, id: string) => object] =>
      typeof entry[1] === "function" && entry[0].endsWith("Query"),
  );
  expect(factories.length).toBe(15);
  const out: Record<string, unknown> = {};
  for (const [name, factory] of factories.sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const { client, calls } = recordingClient();
    const { queryFn, ...options } = factory(client, "id-1") as {
      queryFn: () => Promise<unknown>;
    };
    await queryFn();
    out[name] = { options, calls };
  }
  expect(out).toMatchSnapshot();
});
