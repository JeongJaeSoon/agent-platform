import type { ClaudeRuntimeConfig } from "./config.ts";

export type UnidentifiedComponent = "mcp_server" | "plugin";

/**
 * A run whose config holds something the fingerprint cannot hash by value and
 * the caller did not name. Stable `reason` for hosts that store it; `detail`
 * for people. Thrown from run validation so the refusal happens before any
 * turn runs, not at the first checkpoint.
 */
export class UnidentifiedComponentError extends Error {
  readonly reason = "unidentified_component" as const;

  constructor(
    readonly component: UnidentifiedComponent,
    readonly name: string,
  ) {
    super(
      component === "mcp_server"
        ? `MCP server "${name}" is not plain data and has no identity in identities.mcpServers`
        : `Plugin "${name}" has no identity in identities.plugins`,
    );
  }

  get detail(): string {
    return this.message;
  }
}

export type ComponentDescription = {
  mcpServers: Record<string, unknown>;
  plugins: { identity: string; path: string; type: "local" }[];
};

/**
 * The fingerprint's view of the MCP servers and plugins: serializable servers
 * as their own configuration, everything else as the identity its caller
 * declared. Throws when a component needs an identity and has none, so the
 * caller decides whether that is a refused start or a refused checkpoint.
 *
 * A serializable server is hashed whole — the same registry name can be
 * repointed at a different command or endpoint, and a checkpoint taken under
 * one is not replayable under the other — except for `headers` and `env`,
 * which are reduced to their key names. Those two are where a server's
 * credential lives, and rotating a credential is not a change of tool
 * surface, while adding or removing a header or variable is.
 */
export function describeComponents(
  config: Pick<ClaudeRuntimeConfig, "identities" | "mcpServers" | "plugins">,
): ComponentDescription {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (isPlainData(server, new Set())) {
      mcpServers[name] = withCredentialKeysOnly(server);
      continue;
    }
    const identity = config.identities?.mcpServers?.[name];
    if (identity === undefined) {
      throw new UnidentifiedComponentError("mcp_server", name);
    }
    mcpServers[name] = { identity };
  }
  const plugins = [...(config.plugins ?? [])]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((plugin) => {
      const identity = config.identities?.plugins?.[plugin.path];
      if (identity === undefined) {
        throw new UnidentifiedComponentError("plugin", plugin.path);
      }
      return { identity, path: plugin.path, type: plugin.type };
    });
  return { mcpServers, plugins };
}

const CREDENTIAL_CONTAINERS = new Set(["env", "headers"]);

function withCredentialKeysOnly(server: unknown): unknown {
  if (typeof server !== "object" || server === null || Array.isArray(server)) {
    return server;
  }
  return Object.fromEntries(
    Object.entries(server).map(([key, value]) =>
      CREDENTIAL_CONTAINERS.has(key) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
        ? [key, Object.keys(value).sort()]
        : [key, value],
    ),
  );
}

/**
 * Plain data is what JSON can carry: primitives, arrays and prototype-less or
 * `Object`-prototyped objects, acyclic. A function or a class instance is
 * neither — `createSdkMcpServer` hands back a live, cyclic `McpServer` — and
 * is never descended into, which is also what keeps this walk finite.
 */
function isPlainData(value: unknown, seen: Set<object>): boolean {
  if (Array.isArray(value)) {
    return value.every((item) => isPlainData(item, seen));
  }
  if (typeof value === "function") return false;
  if (typeof value !== "object" || value === null) {
    return typeof value !== "symbol" && typeof value !== "bigint";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).every((nested) => isPlainData(nested, seen));
}
