import { startFakeMcp } from "./fake-mcp.ts";

// A remote MCP server for a local stack: the fake-model catalog's `fake`
// server. A second port, on no worker's allowlist, reports how many tool
// calls arrived and the sha256 of each bearer accepted (GET /calls), never
// a value.
const env = process.env;
const bearer = env.FAKE_MCP_BEARER ?? "";
if (bearer === "") throw new Error("FAKE_MCP_BEARER is required");

const mcp = await startFakeMcp({
  bearer,
  marker: env.FAKE_MCP_MARKER ?? "fake-mcp",
  hostname: "0.0.0.0",
  port: Number(env.FAKE_MCP_PORT ?? "4020"),
});

Bun.serve({
  hostname: "0.0.0.0",
  port: Number(env.FAKE_MCP_CONTROL_PORT ?? "4021"),
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/calls" && request.method === "GET") {
      return Response.json(mcp.calls());
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(JSON.stringify({ msg: "Fake MCP listening", port: mcp.port }));
process.on("SIGTERM", async () => {
  await mcp.stop();
  process.exit(0);
});
