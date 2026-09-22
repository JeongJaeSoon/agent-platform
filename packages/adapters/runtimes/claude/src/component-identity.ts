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
    readonly detail: string,
  ) {
    super(detail);
  }
}

export type ComponentDescription = {
  mcpServers: Record<string, unknown>;
  plugins: { identity: string; path: string; type: "local" }[];
};

/**
 * The fingerprint's view of the MCP servers and plugins. Throws when a
 * component needs an identity and has none, so the caller decides whether
 * that is a refused start or a refused checkpoint.
 *
 * A serializable server (stdio, sse, http) is hashed as its own
 * configuration — the same registry name can be repointed at a different
 * command or endpoint, and a checkpoint taken under one is not replayable
 * under the other — except for `headers` and `env`, which are reduced to
 * their key names. Those two are where a server's credential lives, and
 * rotating a credential is not a change of tool surface. They are also where
 * a tenant binding or a mode flag may live, which key names cannot see, so a
 * server that carries either container needs a declared identity as well:
 * the caller's statement of everything non-secret those values mean.
 *
 * A server that is not plain data — an in-process `{type: "sdk", instance}`
 * entry, or anything holding a function — keeps its plain top-level fields
 * (the registry `name`, the `type`) and hashes the declared identity in place
 * of the object. A plugin is a path whose contents can change underneath it,
 * so every plugin needs one too.
 *
 * An identity is a caller assertion, not a measurement: changing a plugin's
 * contents or a server's tenant binding while keeping the identity is not
 * detectable here. Whoever supplies it owns keeping it honest.
 */
export function describeComponents(
  config: Pick<ClaudeRuntimeConfig, "identities" | "mcpServers" | "plugins">,
): ComponentDescription {
  // Null prototype: a registry named `__proto__` must land as an own entry,
  // not vanish into the prototype setter and out of the fingerprint.
  const mcpServers: Record<string, unknown> = Object.create(null);
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (isPlainData(server, [])) {
      const reduced = withCredentialKeysOnly(server);
      if (!carriesCredentialContainer(server)) {
        mcpServers[name] = reduced;
        continue;
      }
      const identity = declaredIdentity(
        config.identities?.mcpServers,
        "mcp_server",
        name,
        `MCP server "${name}" carries headers or env, whose values the fingerprint does not hash, and has no identity in identities.mcpServers`,
      );
      mcpServers[name] = { ...(reduced as object), identity };
      continue;
    }
    const identity = declaredIdentity(
      config.identities?.mcpServers,
      "mcp_server",
      name,
      `MCP server "${name}" is not plain data and has no identity in identities.mcpServers`,
    );
    mcpServers[name] = { ...plainTopLevelFields(server), identity };
  }
  const plugins = [...(config.plugins ?? [])]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((plugin) => ({
      identity: declaredIdentity(
        config.identities?.plugins,
        "plugin",
        plugin.path,
        `Plugin "${plugin.path}" has no identity in identities.plugins`,
      ),
      path: plugin.path,
      type: plugin.type,
    }));
  return { mcpServers, plugins };
}

function declaredIdentity(
  identities: Record<string, string> | undefined,
  component: UnidentifiedComponent,
  name: string,
  missing: string,
): string {
  // Own properties only: a registry name like `constructor` would otherwise
  // find an inherited function and pass.
  if (identities === undefined || !Object.hasOwn(identities, name)) {
    throw new UnidentifiedComponentError(component, name, missing);
  }
  const identity = identities[name];
  if (typeof identity !== "string" || identity.length === 0) {
    throw new UnidentifiedComponentError(
      component,
      name,
      `Identity declared for ${component === "plugin" ? "plugin" : "MCP server"} "${name}" must be a non-empty string`,
    );
  }
  return identity;
}

const CREDENTIAL_CONTAINERS = ["env", "headers"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function carriesCredentialContainer(server: unknown): boolean {
  if (!isRecord(server)) return false;
  return CREDENTIAL_CONTAINERS.some((key) => {
    const container = server[key];
    return isRecord(container) && Object.keys(container).length > 0;
  });
}

function withCredentialKeysOnly(server: unknown): unknown {
  if (!isRecord(server)) return server;
  return Object.fromEntries(
    Object.entries(server).map(([key, value]) =>
      (CREDENTIAL_CONTAINERS as readonly string[]).includes(key) &&
      isRecord(value)
        ? [key, Object.keys(value).sort()]
        : [key, value],
    ),
  );
}

function plainTopLevelFields(server: unknown): Record<string, unknown> {
  if (!isRecord(server)) return {};
  return Object.fromEntries(
    Object.entries(server).filter(([, value]) => isPlainData(value, [])),
  );
}

/**
 * Plain data is what JSON can carry: primitives, arrays and prototype-less or
 * `Object`-prototyped objects, acyclic. A function or a class instance is
 * neither — `createSdkMcpServer` hands back a live, cyclic `McpServer` — and
 * is never descended into. `stack` holds the objects currently being
 * descended, so a cycle is refused while the same sub-object reached twice
 * along different paths is still plain.
 */
function isPlainData(value: unknown, stack: object[]): boolean {
  if (typeof value === "function") return false;
  if (typeof value !== "object" || value === null) {
    return typeof value !== "symbol" && typeof value !== "bigint";
  }
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  if (stack.includes(value)) return false;
  stack.push(value);
  try {
    return Object.values(value).every((nested) => isPlainData(nested, stack));
  } finally {
    stack.pop();
  }
}
