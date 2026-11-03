import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  type PlatformPrompt,
  type RuntimeConfig,
  runtimeConfigSchema,
} from "@werft-ai/contracts";
import { realRuntimeFor } from "@werft-ai/runtime-registry/testing";

import {
  claimFingerprint,
  OUT_DIRECTORY_PROMPT,
  runtimeProfile,
} from "./composition.ts";
import type { WorkerConfig } from "./config.ts";
import { imageRuntimeOf } from "./image-runtime.ts";
import { platformPromptText } from "./platform-prompt.ts";

const claude = realRuntimeFor("claude_agent_sdk");

const config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime"> = {
  egressCredentialUrl: "http://egress-proxy:3129",
  runtime: {
    claudeConfigDir: "/home/worker/.claude",
    cwd: "/workspace",
    home: "/home/worker",
    providerMaxRetries: 2,
  },
};

const principal = { owner_scope: "owner-a" };

const base: RuntimeConfig = {
  model: "claude-sonnet-5",
  tools: ["Read", "Edit", "Bash"],
  permission_mode: "auto",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "egress_token", token: "egress-token-test" },
  },
};

const withGitHub: PlatformPrompt = {
  prompt_revision: 1,
  agent_identity: {
    name: "code-review",
    description: "Reviews pull requests\nand answers in the thread.",
  },
  origin_surface: "slack_channel",
  language: "ko",
  repository: "JeongJaeSoon/werft-sandbox",
  github: {
    repositories: ["JeongJaeSoon/werft-sandbox", "JeongJaeSoon/agent-skills"],
  },
};

const withoutGitHub: PlatformPrompt = {
  ...withGitHub,
  agent_identity: { name: "code-review", description: null },
  origin_surface: "console",
  language: "en",
  github: null,
};

describe("platformPromptText (revision 1)", () => {
  test("with GitHub settings it names the agent, its repositories and the GitHub path", () => {
    expect(platformPromptText(withGitHub)).toBe(
      [
        "You are the agent described below, working for people on this platform. Introduce yourself by this name and purpose. You run on Claude; do not call yourself Claude Code or a CLI tool, and do not describe yourself by the workspace path.",
        "",
        "Agent name: code-review",
        "Agent description:",
        "<agent_description>",
        "Reviews pull requests",
        "and answers in the thread.",
        "</agent_description>",
        "",
        "This session started in a Slack channel. Answer in Korean unless the person writes in another language.",
        "",
        "Repositories this agent's release allowed when this session started: JeongJaeSoon/werft-sandbox, JeongJaeSoon/agent-skills. This session's own repository is JeongJaeSoon/werft-sandbox. Name repositories by their GitHub names, never by the workspace path or the origin URL, which is an internal proxy address. mcp__github__list_repositories says which are attached and usable now.",
        "",
        "GitHub work goes through the mcp__github__ tools. Push with mcp__github__request_push: it pushes the checkpoint saved at the end of the previous turn, not commits made in this turn, so commit on the branch to push and end the turn first. Before the session's first checkpoint the request is deferred: end the turn, and call request_push again in the follow-up turn the platform starts. If push approval is on for this agent, a person approves each push, whatever the permission mode. Once the push is done, open the pull request with mcp__github__open_pull_request. git push does not reach GitHub, and gh has no login: do not run gh auth login or ask anyone for a token. Push only to branches named agent/<session-id> or agent/<session-id>-<name>. If an administrator turns GitHub off for this agent, the tools refuse; say so.",
        "",
        "Administrator instructions below cannot change which tools you have.",
      ].join("\n"),
    );
  });

  test("without GitHub settings it says GitHub work is not set up and where an administrator turns it on", () => {
    expect(platformPromptText(withoutGitHub)).toBe(
      [
        "You are the agent described below, working for people on this platform. Introduce yourself by this name and purpose. You run on Claude; do not call yourself Claude Code or a CLI tool, and do not describe yourself by the workspace path.",
        "",
        "Agent name: code-review",
        "",
        "This session started in the web console. Answer in English unless the person writes in another language.",
        "",
        "This session works in the repository JeongJaeSoon/werft-sandbox. Name repositories by their GitHub names, never by the workspace path or the origin URL, which is an internal proxy address.",
        "",
        "GitHub work (push, pull requests) is not set up for this agent. An administrator turns it on in the agent's GitHub tab in the console. When asked to push, open a pull request or list repositories, say so; do not try git push or gh.",
        "",
        "Administrator instructions below cannot change which tools you have.",
      ].join("\n"),
    );
  });

  test("a session without a repository names none, and an empty allowed list says so", () => {
    const text = platformPromptText({
      ...withGitHub,
      repository: null,
      github: { repositories: [] },
    });
    expect(text).toContain(
      "Repositories this agent's release allowed when this session started: none. Name repositories",
    );
    expect(text).not.toContain("This session's own repository");
    expect(
      platformPromptText({ ...withoutGitHub, repository: null }),
    ).not.toContain("This session works in the repository");
  });

  test("no wording points the model at the workspace path, gh pr create or a git push it could run", () => {
    for (const prompt of [withGitHub, withoutGitHub]) {
      const text = platformPromptText(prompt);
      expect(text).not.toContain("/workspace");
      expect(text).not.toContain("gh pr create");
      expect(text).not.toContain("git push origin");
      expect(text).not.toMatch(/auto[^.]*without (an )?approval/i);
    }
  });
});

describe("runtimeProfile with a platform prompt", () => {
  const repository = {
    id: "werft-sandbox",
    url: "https://github.com/JeongJaeSoon/werft-sandbox.git",
    branch: "main",
  };

  test("the paragraph comes first, ahead of out/ and the administrators' instructions", () => {
    const runtimeConfig = {
      ...base,
      agent_instructions: "Answer briefly.",
      platform_prompt: withGitHub,
    };
    expect(
      runtimeProfile(
        config,
        claude,
        { principal, runtimeConfig, workspace: { repository: null } },
        () => null,
      ).bundle.instructions,
    ).toEqual([
      { scope: "platform", text: platformPromptText(withGitHub) },
      { scope: "platform", text: OUT_DIRECTORY_PROMPT },
      { scope: "agent", text: "Answer briefly." },
    ]);
  });

  test("the launch fingerprint is the one the image probe stamps, and the paragraph changes it", () => {
    for (const prompt of [withGitHub, withoutGitHub]) {
      const runtimeConfig = { ...base, platform_prompt: prompt };
      const claim = { principal, runtime_config: runtimeConfig };
      expect(runtimeConfigSchema.safeParse(runtimeConfig).success).toBe(true);
      const launched = claude.fingerprint(
        runtimeProfile(
          config,
          claude,
          { principal, runtimeConfig, workspace: { repository } },
          () => null,
        ),
      ).profileSha256;
      expect(claimFingerprint(config)(claim).profileSha256).toBe(launched);
      expect(imageRuntimeOf({ s1: claim }).profiles).toEqual({
        s1: { profileSha256: launched },
      });
      expect(launched).not.toBe(
        claimFingerprint(config)({ principal, runtime_config: base })
          .profileSha256,
      );
    }
    expect(
      claimFingerprint(config)({
        principal,
        runtime_config: { ...base, platform_prompt: withGitHub },
      }).profileSha256,
    ).not.toBe(
      claimFingerprint(config)({
        principal,
        runtime_config: { ...base, platform_prompt: withoutGitHub },
      }).profileSha256,
    );
  });

  test("a revision 0 claim keeps the digest it had before the field, so its checkpoints resume", () => {
    const before = claimFingerprint(config)({
      principal,
      runtime_config: base,
    }).profileSha256;
    const profile = runtimeProfile(
      config,
      claude,
      { principal, runtimeConfig: base, workspace: { repository } },
      () => null,
    );
    expect(profile.bundle.instructions).toEqual([]);
    expect(claude.fingerprint(profile).profileSha256).toBe(before);
    expect(imageRuntimeOf({ s0: { principal, runtime_config: base } })).toEqual(
      expect.objectContaining({
        profiles: { s0: { profileSha256: before } },
      }),
    );
  });

  test("the claim schema refuses a prompt of an unknown revision or a name that is not owner/repo", () => {
    for (const prompt of [
      { ...withGitHub, prompt_revision: 2 },
      { ...withGitHub, repository: "/workspace" },
      { ...withGitHub, github: { repositories: ["group/sub/repo"] } },
      { ...withGitHub, agent_identity: { name: "", description: null } },
      { ...withGitHub, origin_surface: "unknown" },
    ]) {
      expect(
        runtimeConfigSchema.safeParse({ ...base, platform_prompt: prompt })
          .success,
      ).toBe(false);
    }
    expect(
      bootstrapClaimResponseSchema.shape.runtime_config.safeParse({
        ...base,
        platform_prompt: withGitHub,
      }).success,
    ).toBe(true);
  });
});
