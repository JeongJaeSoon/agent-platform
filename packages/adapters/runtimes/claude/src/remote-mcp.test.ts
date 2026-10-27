import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type FakeMcp,
  sha256Hex,
  startFakeMcp,
} from "@werft-ai/testkit/fake-mcp";
import { relayedToolDescriptions, remoteMcpRelay } from "./remote-mcp.ts";

const BEARER = "service-account-value-for-the-relay-test";

let fake: FakeMcp | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

async function through(options: { token: string; tools: string[] }) {
  fake = await startFakeMcp({ bearer: BEARER, marker: "m1" });
  const relay = remoteMcpRelay({
    name: "fake",
    url: `http://127.0.0.1:${fake.port}/mcp`,
    token: options.token,
    tools: options.tools,
  });
  const [engineSide, relaySide] = InMemoryTransport.createLinkedPair();
  await relay.instance.connect(relaySide);
  const engine = new Client({ name: "engine", version: "1" });
  await engine.connect(engineSide);
  return { engine, relay };
}

describe("remoteMcpRelay", () => {
  test("lists and calls only the pinned tools, with the route's bearer", async () => {
    const { engine } = await through({
      token: BEARER,
      tools: ["Read", "mcp__fake__whoami", "mcp__other__whoami"],
    });
    const listed = await engine.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["whoami"]);
    expect(await engine.callTool({ name: "whoami" })).toMatchObject({
      content: [{ type: "text", text: "ok:m1" }],
    });
    expect(await engine.callTool({ name: "other" })).toMatchObject({
      isError: true,
    });
    expect(fake?.calls()).toEqual({
      calls: 1,
      authorization_sha256: [sha256Hex(BEARER)],
    });
  });

  test("keeps the descriptions of the tools it last listed, by engine name", async () => {
    const { engine, relay } = await through({
      token: BEARER,
      tools: ["mcp__fake__whoami"],
    });
    const servers = { fake: relay, plain: { command: "local-mcp" } };
    expect([...relayedToolDescriptions(servers)]).toEqual([]);
    await engine.listTools();
    expect([...relayedToolDescriptions(servers)]).toEqual([
      ["mcp__fake__whoami", "Says who the server thinks is calling"],
    ]);
    expect(relayedToolDescriptions(undefined).size).toBe(0);
  });

  test("a refused upstream is a tool error naming the refusal", async () => {
    const { engine } = await through({
      token: "not-the-bearer",
      tools: ["mcp__fake__whoami"],
    });
    const result = await engine.callTool({ name: "whoami" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unauthorized");
    expect(fake?.calls().calls).toBe(0);
  });
});
