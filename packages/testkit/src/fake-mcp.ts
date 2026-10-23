import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type FakeMcpCalls = {
  /** tools/call requests that reached a tool. */
  calls: number;
  /** sha256 hex of each distinct bearer value the server accepted. */
  authorization_sha256: string[];
};

export type FakeMcp = {
  readonly port: number;
  calls(): FakeMcpCalls;
  stop(): Promise<void>;
};

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * A remote MCP server behind a service-account bearer, stateless streamable
 * HTTP at `/mcp`. `whoami` answers `ok:<marker>`; `other` exists so a tool
 * the release does not pin has something to be refused for. A missing or
 * wrong bearer is 401. Only hashes of what it was sent are kept.
 */
export async function startFakeMcp(options: {
  bearer: string;
  marker: string;
  hostname?: string;
  port?: number;
}): Promise<FakeMcp> {
  let calls = 0;
  const seen = new Set<string>();
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname !== "/mcp") {
        return new Response("not found", { status: 404 });
      }
      const presented = /^Bearer (.+)$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (presented !== options.bearer) {
        return new Response("unauthorized", { status: 401 });
      }
      seen.add(sha256Hex(presented));
      const mcp = new McpServer({ name: "fake", version: "1" });
      mcp.tool("whoami", "Says who the server thinks is calling", async () => {
        calls += 1;
        return { content: [{ type: "text", text: `ok:${options.marker}` }] };
      });
      mcp.tool("other", "A tool no release pins", async () => {
        calls += 1;
        return { content: [{ type: "text", text: "other" }] };
      });
      // No session id generator: stateless, a server per request.
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await mcp.connect(transport as Transport);
      return transport.handleRequest(request);
    },
  });
  return {
    port: server.port ?? 0,
    calls: () => ({ calls, authorization_sha256: [...seen].sort() }),
    stop: async () => {
      await server.stop(true);
    },
  };
}
