import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  acceptInviteRequestSchema,
  createAgentRequestSchema,
  createInviteRequestSchema,
} from "@werft-ai/contracts";
import {
  type AgentCardDraft,
  acceptInviteStep,
  agentCardStep,
  agentIdentityStep,
  agentReleaseStep,
  inviteStep,
} from "./index.ts";

const BASE: AgentCard = {
  role: "Support agent",
  instructions: "Answer refund questions.",
  language: "en",
  model: "claude-sonnet-5",
  capabilities: {
    tools: ["Read", "Grep"],
    mcp: null,
    forbidden: ["Bash"],
    tool_policy: {
      default: { mcp: "deny" },
      per_tool: { Read: "allow", Bash: "ask" },
    },
    credential_refs: ["github/app", "slack:bot"],
  },
  rules: [{ id: "r1", text: "Hand refunds to a person.", source: "user" }],
};

const DRAFT: AgentCardDraft = {
  role: "Support agent",
  instructions: "Answer refund questions.",
  language: "en",
  model: "claude-sonnet-5",
  toolsMode: "list",
  tools: "Read\nGrep",
  forbidden: "Bash",
};

const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join(".")) ?? [];

describe("steps validate trimmed values", () => {
  test("whitespace alone is empty", () => {
    const result = agentIdentityStep.safeParse({ slug: "   ", name: " \t " });
    expect(
      result.error?.issues
        .filter((issue) => issue.code === "too_small")
        .map((issue) => issue.path.join(".")),
    ).toEqual(["slug", "name"]);
  });

  test("the release step needs a profile and sends it and the repository trimmed", () => {
    expect(
      agentReleaseStep.safeParse({
        runtime_profile_id: "  ",
        repository_id: "",
      }).success,
    ).toBe(false);
    expect(
      agentReleaseStep.parse({
        runtime_profile_id: " claude-coding-local ",
        repository_id: " sample-app ",
      }),
    ).toEqual({
      runtime_profile_id: "claude-coding-local",
      repository_id: "sample-app",
    });
  });

  test("the value sent is the trimmed one", () => {
    expect(
      agentIdentityStep.parse({ slug: "  refunds ", name: " Refunds  " }),
    ).toEqual({ slug: "refunds", name: "Refunds" });
    expect(
      inviteStep.parse({ email: " ada@example.com ", role: "member" }),
    ).toEqual({ email: "ada@example.com", role: "member" });
  });

  test("the contract's own limits apply after the trim", () => {
    const long = `  ${"a".repeat(64)}  `;
    expect(agentIdentityStep.safeParse({ slug: long, name: "x" }).success).toBe(
      true,
    );
    expect(
      agentIdentityStep.safeParse({ slug: `${long}a`, name: "x" }).success,
    ).toBe(false);
    expect(
      agentIdentityStep.safeParse({ slug: "Not Kebab", name: "x" }).success,
    ).toBe(false);
  });

  test("a card field of whitespace fails on that field", () => {
    const result = agentCardStep().safeParse({ ...DRAFT, role: "   " });
    expect(paths(result)).toEqual(["role"]);
  });
});

describe("the card step keeps what its base has", () => {
  test("a field the form has no input for survives an edit", () => {
    const card = agentCardStep(BASE).parse({ ...DRAFT, role: "Refund lead" });
    expect<unknown>(card).toEqual({ ...BASE, role: "Refund lead" });
  });

  test("the form's inputs win over the base", () => {
    const card = agentCardStep(BASE).parse({
      ...DRAFT,
      toolsMode: "all",
      forbidden: "",
      language: "ko",
    });
    expect(card.capabilities.tools).toBeNull();
    expect(card.capabilities.forbidden).toEqual([]);
    expect(card.language).toBe("ko");
    expect(card.capabilities.tool_policy).toEqual(
      BASE.capabilities.tool_policy,
    );
    expect(card.rules).toEqual(BASE.rules);
  });

  test("without a base the contract's defaults fill in", () => {
    const card = agentCardStep().parse(DRAFT);
    expect(card.rules).toEqual([]);
    expect("tool_policy" in card.capabilities).toBe(false);
  });
});

test("the steps join into requests the contract accepts", () => {
  const identity = agentIdentityStep.parse({ slug: " refunds", name: "R " });
  const card = agentCardStep(BASE).parse(DRAFT);
  expect(
    createAgentRequestSchema.safeParse({ ...identity, card }).success,
  ).toBe(true);
  const invite = inviteStep.parse({ email: "a@example.com ", role: "admin" });
  expect(createInviteRequestSchema.safeParse(invite).success).toBe(true);
  const accept = acceptInviteStep.parse({
    password: " correct horse ",
    display_name: " Ada ",
  });
  expect(
    acceptInviteRequestSchema.safeParse({ token: "t".repeat(43), ...accept })
      .success,
  ).toBe(true);
});

describe("accepting an invite", () => {
  test("the password keeps its spaces; the name is trimmed", () => {
    expect(
      acceptInviteStep.parse({
        password: " correct horse ",
        display_name: " Ada ",
      }),
    ).toEqual({ password: " correct horse ", display_name: "Ada" });
  });

  test("an empty name is left out instead of failing", () => {
    const accept = acceptInviteStep.parse({
      password: "correct horse battery",
      display_name: "   ",
    });
    expect(accept.display_name).toBeUndefined();
  });

  test("a short password and a long name fail on their own paths", () => {
    expect(
      paths(
        acceptInviteStep.safeParse({
          password: "short",
          display_name: "a".repeat(65),
        }),
      ),
    ).toEqual(["password", "display_name"]);
  });
});
