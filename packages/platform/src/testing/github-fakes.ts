import { randomBytes } from "node:crypto";
import type { EffectiveGitHubPolicy } from "@werft-ai/contracts";

/** A session on its release's pin, as the resolver answers it. */
export function releasePolicy(
  settings: EffectiveGitHubPolicy["settings"],
): EffectiveGitHubPolicy {
  return {
    source: "release",
    settings,
    startRepositoryId: null,
    agentSettingsRevision: null,
    currentRepositories: null,
    startActionsAllow: null,
    enabledAtStart: true,
    pushAttached: "ask",
  };
}

/** A session on its agent's settings row, as the resolver answers it. */
export function agentPolicy(
  settings: EffectiveGitHubPolicy["settings"],
  options: {
    startRepositoryId?: string | null;
    revision?: number;
    pushAttached?: EffectiveGitHubPolicy["pushAttached"];
  } = {},
): EffectiveGitHubPolicy {
  return {
    source: "agent",
    settings,
    startRepositoryId: options.startRepositoryId ?? null,
    agentSettingsRevision: options.revision ?? 1,
    currentRepositories: null,
    startActionsAllow: null,
    enabledAtStart: true,
    pushAttached: options.pushAttached ?? "ask",
  };
}

/** A GitHub OAuth client secret's shape, made per run, never written into a file. */
export function fakeGitHubClientSecret(): string {
  return randomBytes(20).toString("hex");
}
