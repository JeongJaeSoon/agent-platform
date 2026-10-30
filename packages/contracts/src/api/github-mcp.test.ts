import { describe, expect, test } from "bun:test";
import type { AgentGitHub } from "../kollegium/agents.ts";
import { runtimeConfigSchema } from "../worker-protocol/index.ts";
import {
  GITHUB_MCP_TOOL_ARGUMENTS,
  githubMcpToolNames,
  githubMcpTools,
} from "./github-mcp.ts";

const off: AgentGitHub["features"] = {
  workflows: false,
  actions: false,
  checks: false,
  issues: false,
  review: false,
};
const settings = (features: Partial<AgentGitHub["features"]>): AgentGitHub => ({
  repositories: ["app"],
  push_approval: true,
  features: { ...off, ...features },
  actions_allow: [],
});

describe("githubMcpTools", () => {
  test("exposes the default work always and a feature's tools only when it is on", () => {
    expect(githubMcpTools(settings({}))).toEqual([
      "request_push",
      "open_pull_request",
      "comment_pull_request",
    ]);
    expect(
      githubMcpTools(settings({ workflows: true, checks: true, issues: true })),
    ).toEqual(["request_push", "open_pull_request", "comment_pull_request"]);
    expect<string[]>(
      githubMcpTools(settings({ actions: true, review: true })),
    ).toEqual(Object.keys(GITHUB_MCP_TOOL_ARGUMENTS));
    expect(githubMcpToolNames(settings({ review: true }))).toContain(
      "mcp__github__submit_review",
    );
  });

  test("no tool's arguments take a session id", () => {
    for (const schema of Object.values(GITHUB_MCP_TOOL_ARGUMENTS)) {
      expect(
        schema.safeParse({
          session_id: "11111111-1111-4111-8111-111111111111",
        }).success,
      ).toBe(false);
    }
  });
});

describe("runtime config mcp_servers", () => {
  const server = (name: string) => ({
    name,
    endpoint: "https://builtin.invalid/mcp/github",
    binding: `sha256:${"0".repeat(64)}`,
    access: { kind: "egress_token", token: "wem_x" },
  });
  const servers = runtimeConfigSchema.shape.mcp_servers;

  test("carries a catalog server and the built-in one, never the same twice", () => {
    expect(servers.safeParse([server("fake"), server("github")]).success).toBe(
      true,
    );
    expect(
      servers.safeParse([server("github"), server("github")]).success,
    ).toBe(false);
    expect(
      servers.safeParse([server("a"), server("b"), server("c")]).success,
    ).toBe(false);
  });
});
