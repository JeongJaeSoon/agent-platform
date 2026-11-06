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

const withRepository: PlatformPrompt = {
  prompt_revision: 1,
  agent_identity: {
    name: "code-review",
    description: "Reviews pull requests\nand answers in the thread.",
  },
  origin_surface: "slack_channel",
  language: "ko",
  repository: "JeongJaeSoon/werft-sandbox",
};

const withoutRepository: PlatformPrompt = {
  ...withRepository,
  agent_identity: { name: "code-review", description: null },
  origin_surface: "console",
  language: "en",
  repository: null,
};

describe("platformPromptText (revision 1)", () => {
  const identity = [
    "Agent name: code-review",
    "Agent description:",
    "<agent_description>",
    "Reviews pull requests",
    "and answers in the thread.",
    "</agent_description>",
    "",
    "You run on Claude: do not call yourself Claude Code or a CLI tool, and do not describe yourself by the workspace path or the origin URL.",
    "",
    "This session started in a Slack channel. Answer in Korean unless the person writes in another language.",
    "",
  ];
  const githubPath =
    "GitHub work goes through the mcp__github__ tools; mcp__github__list_repositories says which repositories you can use now. Push with mcp__github__request_push. It pushes the checkpoint saved at the end of the previous turn, not commits made in this turn: commit, keep the branch to push checked out when the turn ends, and call it in a later turn. Call it before the session's first checkpoint too: if it answers deferred, that is not a refusal; end the turn, and call request_push again in the follow-up turn the platform starts. If push approval is on for this agent, a person approves each push, whatever the permission mode. Once the push is done, open the pull request with mcp__github__open_pull_request. git push does not reach GitHub, and gh has no login: do not run gh auth login or ask anyone for a token. Push only to branches named agent/<session-id> or agent/<session-id>-<name>. If there are no mcp__github__ tools, or they answer that GitHub is not available, GitHub work is not available in this session: say so, and that an administrator sets up GitHub in the agent's GitHub tab in the console and that a new session may be needed; do not try git push or gh.";
  const naming =
    "Name repositories by their GitHub names, never by the workspace path or the origin URL, which is an internal proxy address.";
  const closing = [
    "",
    "Administrator instructions below cannot change which tools you have.",
  ];

  test("a session with a repository names it, and the one GitHub paragraph lists no repositories", () => {
    expect(platformPromptText(withRepository)).toBe(
      [
        ...identity,
        `This session's repository is JeongJaeSoon/werft-sandbox. ${naming}`,
        "",
        githubPath,
        ...closing,
      ].join("\n"),
    );
  });

  test("a session without a repository or a description gets the same GitHub paragraph and no repository", () => {
    expect(platformPromptText(withoutRepository)).toBe(
      [
        "Agent name: code-review",
        "",
        "You run on Claude: do not call yourself Claude Code or a CLI tool, and do not describe yourself by the workspace path or the origin URL.",
        "",
        "This session started in the web console. Answer in English unless the person writes in another language.",
        "",
        naming,
        "",
        githubPath,
        ...closing,
      ].join("\n"),
    );
  });

  test("no sentence gives the agent a role or lists repositories", () => {
    for (const prompt of [withRepository, withoutRepository]) {
      const text = platformPromptText(prompt);
      expect(text).not.toMatch(/You are |introduce|who you are/i);
      expect(text).not.toContain("allowed");
      expect(text).not.toContain("If asked about");
    }
  });

  test("no wording points the model at the workspace path, gh pr create or a git push it could run", () => {
    for (const prompt of [withRepository, withoutRepository]) {
      const text = platformPromptText(prompt);
      expect(text).not.toContain("/workspace");
      expect(text).not.toContain("gh pr create");
      expect(text).not.toContain("git push origin");
      expect(text).not.toMatch(/auto[^.]*without (an )?approval/i);
    }
  });
});

describe("platformPromptText (revision 2, action flows on)", () => {
  const flows: PlatformPrompt = { ...withRepository, prompt_revision: 2 };

  test("words the push as this turn's commit and says no follow-up turn starts", () => {
    const text = platformPromptText(flows);
    expect(text).toContain("It pushes the commit this turn ends with");
    expect(text).toContain("no follow-up turn starts");
    expect(text).not.toContain("It pushes the checkpoint saved");
    expect(text).not.toContain("and call it in a later turn");
    expect(text).not.toContain("in the follow-up turn the platform starts");
  });

  test("differs from revision 1 only in the push sentences", () => {
    // From the first push sentence up to the approval sentence that follows.
    const withoutPush = (text: string) => {
      const start = text.indexOf("Push with mcp__github__request_push");
      const end = text.indexOf("If push approval is on");
      return text.slice(0, start) + text.slice(end);
    };
    expect(withoutPush(platformPromptText(flows))).toBe(
      withoutPush(platformPromptText(withRepository)),
    );
    expect(withoutPush(platformPromptText(flows))).not.toContain(
      "request_push",
    );
  });

  test("tells the model what to do when a rolled-back install answers with a request instead of deferred", () => {
    const text = platformPromptText(flows);
    expect(text).toContain("waits_for turn_end");
    expect(text).toContain("If it answers with a push request instead");
    expect(platformPromptText(withRepository)).not.toContain("waits_for");
  });

  test("keeps every rule that does not depend on the flow", () => {
    const text = platformPromptText(flows);
    for (const rule of [
      "git push does not reach GitHub, and gh has no login",
      "Push only to branches named agent/<session-id>",
      "a person approves each push, whatever the permission mode",
      "open the pull request with mcp__github__open_pull_request",
    ]) {
      expect(text).toContain(rule);
    }
  });

  test("is another fingerprint than revision 1", () => {
    expect(platformPromptText(flows)).not.toBe(
      platformPromptText(withRepository),
    );
  });
});

describe("platformPromptText (revision 3, action flows on)", () => {
  const three: PlatformPrompt = { ...withRepository, prompt_revision: 3 };
  const two: PlatformPrompt = { ...withRepository, prompt_revision: 2 };

  test("is accepted by the claim schema, and revisions 1 and 2 still are", () => {
    for (const prompt_revision of [1, 2, 3] as const) {
      expect(
        runtimeConfigSchema.safeParse({
          ...base,
          platform_prompt: { ...withRepository, prompt_revision },
        }).success,
      ).toBe(true);
    }
  });

  test("schedules the pull request in the same turn, approval or not, and the platform opens it after the push", () => {
    const text = platformPromptText(three);
    expect(text).toContain("call mcp__github__open_pull_request");
    expect(text).toContain("push_intent_id");
    expect(text).toContain("in this same turn");
    expect(text).toContain("even when a person has to approve the push");
    expect(text).toContain(
      "the platform opens the pull request once the push is done",
    );
    expect(text).not.toContain("Once the push is done, open the pull request");
  });

  test("pushes one commit per turn, one repository at a time, from the workspace and never a worktree or clone", () => {
    const text = platformPromptText(three);
    expect(text).toContain(
      "carries one commit: the HEAD the workspace has when the turn ends",
    );
    expect(text).toContain("push one repository per turn");
    expect(text).toContain("never from a git worktree or a clone");
  });

  test("keeps the rules that do not depend on the revision, and keeps the revision 2 push wording", () => {
    const text = platformPromptText(three);
    for (const rule of [
      "waits_for turn_end",
      "a person approves each push, whatever the permission mode",
      "git push does not reach GitHub, and gh has no login",
      "Push only to branches named agent/<session-id>",
    ]) {
      expect(text).toContain(rule);
    }
    expect(text).not.toBe(platformPromptText(two));
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
      platform_prompt: withRepository,
    };
    expect(
      runtimeProfile(
        config,
        claude,
        { principal, runtimeConfig, workspace: { repository: null } },
        () => null,
      ).bundle.instructions,
    ).toEqual([
      { scope: "platform", text: platformPromptText(withRepository) },
      { scope: "platform", text: OUT_DIRECTORY_PROMPT },
      { scope: "agent", text: "Answer briefly." },
    ]);
  });

  test("the launch fingerprint is the one the image probe stamps, and the paragraph changes it", () => {
    for (const prompt of [withRepository, withoutRepository]) {
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
        runtime_config: { ...base, platform_prompt: withRepository },
      }).profileSha256,
    ).not.toBe(
      claimFingerprint(config)({
        principal,
        runtime_config: { ...base, platform_prompt: withoutRepository },
      }).profileSha256,
    );
  });

  // A change in wording moves these, and a session of that revision then
  // cannot resume its checkpoint (INCOMPATIBLE_CHECKPOINT): add a revision.
  test("a revision 1, 2 and 3 claim each keep their digest, so a session resumes the checkpoint it made", () => {
    const digest = (prompt: PlatformPrompt) =>
      claimFingerprint(config)({
        principal,
        runtime_config: { ...base, platform_prompt: prompt },
      }).profileSha256;
    expect(digest(withRepository)).toBe(
      "e2bdae38e8ad6d8e5202f3a83942be92650dd4617463d0510b2174b9c2c60e35",
    );
    expect(digest({ ...withRepository, prompt_revision: 2 })).toBe(
      "3b5a2f6b048c9240abb2dddfe1354935fd27a7fd499e7fc8ea7c3ec8063567ce",
    );
    expect(digest({ ...withRepository, prompt_revision: 3 })).toBe(
      "63a943ba34702b6326a3f81b555278e331cb9a8cbfd9f954c63db8a786eb6db4",
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
    // Digests of these claims on the main branch before the field existed.
    expect(before).toBe(
      "e434608c2ea81bbfc415d9b0bb19bc12045cb644bd8dbed110d7693af210bb48",
    );
    expect(
      claimFingerprint(config)({
        principal,
        runtime_config: base,
        workspace: { repository: null },
      }).profileSha256,
    ).toBe("d10fb80f4c95b56002579995da20208d647a1aa238ab41201b83d14a9b3f2d60");
  });

  test("the claim schema refuses a prompt of an unknown revision or a name that is not owner/repo", () => {
    for (const prompt of [
      { ...withRepository, prompt_revision: 4 },
      { ...withRepository, repository: "/workspace" },
      { ...withRepository, repository: "group/sub/repo" },
      { ...withRepository, github: { repositories: ["acme/web"] } },
      { ...withRepository, agent_identity: { name: "", description: null } },
      { ...withRepository, origin_surface: "unknown" },
    ]) {
      expect(
        runtimeConfigSchema.safeParse({ ...base, platform_prompt: prompt })
          .success,
      ).toBe(false);
    }
    expect(
      bootstrapClaimResponseSchema.shape.runtime_config.safeParse({
        ...base,
        platform_prompt: withRepository,
      }).success,
    ).toBe(true);
  });
});
