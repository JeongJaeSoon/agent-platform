import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// Just under the egress proxy's own deadline for one exchange, so the proxy
// is what ends a call that runs that long, not a timer here.
const CALL_TIMEOUT_MS = 30 * 60_000;
const MAX_LIST_PAGES = 50;

export type RemoteMcpServer = {
  /** The registry name: the engine names its tools `mcp__<name>__<tool>`. */
  name: string;
  /** The egress proxy's route for this server. */
  url: string;
  /** The attempt's egress token for that route. */
  token: string;
  /** The `mcp__<name>__<tool>` names the release allows. */
  tools: readonly string[];
};

/**
 * A remote MCP server as an in-process one: the engine talks to this relay,
 * and the relay talks to the egress proxy with the attempt's token. The
 * token stays in this process, never in the engine's argv or environment,
 * where `--mcp-config` would have put it. The engine sees only the tools the
 * release pins; the proxy refuses any other call on its own.
 */
export function remoteMcpRelay(server: RemoteMcpServer): {
  type: "sdk";
  name: string;
  instance: McpServer;
} {
  const prefix = `mcp__${server.name}__`;
  const pinned = new Set(
    server.tools
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length)),
  );
  let upstream: Promise<Client> | undefined;
  const connected = () => {
    upstream ??= (async () => {
      const client = new Client({ name: "werft-worker", version: "1" });
      // The SDK's own transport, typed without exactOptionalPropertyTypes.
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { authorization: `Bearer ${server.token}` } },
      }) as Transport;
      await client.connect(transport);
      return client;
    })();
    // A failed connect is tried again on the next request, not kept.
    upstream.catch(() => {
      upstream = undefined;
    });
    return upstream;
  };
  const relay = new McpServer(
    { name: server.name, version: "1" },
    { capabilities: { tools: {} } },
  );
  relay.server.setRequestHandler(ListToolsRequestSchema, async (_, extra) => {
    const client = await connected();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await client.listTools(
        cursor === undefined ? {} : { cursor },
        { signal: extra.signal },
      );
      tools.push(...listed.tools.filter((tool) => pinned.has(tool.name)));
      cursor = listed.nextCursor;
      if (cursor === undefined) break;
    }
    return { tools };
  });
  relay.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const { name } = request.params;
      if (!pinned.has(name)) return failed(`Tool ${name} is not allowed`);
      try {
        const client = await connected();
        return (await client.callTool(request.params, undefined, {
          signal: extra.signal,
          timeout: CALL_TIMEOUT_MS,
        })) as CallToolResult;
      } catch (error) {
        // The proxy's refusal, receipt id included, is what the model and
        // the session's events get to read.
        return failed(error instanceof Error ? error.message : String(error));
      }
    },
  );
  return { type: "sdk", name: server.name, instance: relay };
}

function failed(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
