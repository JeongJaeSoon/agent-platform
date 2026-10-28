import type {
  InstallationProfileOptionsResponse,
  InstallationProfileState,
  ProfileSummary,
  WorkspaceProfileState,
} from "@werft-ai/contracts";
import { USER_ID } from "./fake-api.ts";

/** Profiles as GET /v1/profiles lists them, for the run profile screens. */

export const RECEIPT_ID = "00000000-0000-4000-8000-000000000001";

type Installation = NonNullable<ProfileSummary["installation"]>;

/** A ceiling imported from profiles.yaml: its id is its name. */
export function imported(
  id: string,
  narrowed: Partial<ProfileSummary> = {},
  state: InstallationProfileState = "usable",
): ProfileSummary {
  return {
    id,
    source: "operator",
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-haiku-5"],
    tools: ["Read", "Edit", "Bash"],
    permission_mode: "acceptEdits",
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    billing: "metered",
    repository_mode: "required",
    repository_ids: ["platform"],
    ...narrowed,
    installation: {
      name: null,
      version: 1,
      origin: "catalog",
      state,
      connection_id: "anthropic",
      title_model: null,
      project_settings: { claude_md: false },
      previous_id: null,
      created_by: null,
      created_at: "2026-10-20T00:00:00.000Z",
      retired_by: null,
      retired_at: state === "retired" ? "2026-10-27T01:00:00.000Z" : null,
    },
  };
}

/** Version `n` of the console ceiling `name`, `op_<name>_v<n>`. */
export function ceiling(
  name: string,
  n: number,
  narrowed: Partial<ProfileSummary> = {},
  installation: Partial<Installation> = {},
): ProfileSummary {
  const base = imported(`op_${name}_v${n}`, narrowed);
  const state = installation.state ?? "usable";
  return {
    ...base,
    installation: {
      ...(base.installation as Installation),
      name,
      version: n,
      origin: "console",
      title_model: "claude-haiku-5",
      project_settings: { claude_md: true },
      previous_id: n === 1 ? null : `op_${name}_v${n - 1}`,
      created_by: USER_ID,
      created_at: `2026-10-2${n}T00:00:00.000Z`,
      retired_by: state === "retired" ? USER_ID : null,
      retired_at: state === "retired" ? "2026-10-27T01:00:00.000Z" : null,
      ...installation,
    },
  };
}

/** Version `n` of the workspace profile `strict`, narrowing `base`. */
export function version(
  n: number,
  state: WorkspaceProfileState,
  narrowed: Partial<ProfileSummary> = {},
  base = "coding-claude",
): ProfileSummary {
  const { installation: _, ...over } = imported(base);
  return {
    ...over,
    id: `ws_acme_strict_v${n}`,
    source: "workspace",
    models: ["claude-sonnet-5"],
    tools: ["Read"],
    permission_mode: "default",
    ...narrowed,
    workspace: {
      name: "strict",
      version: n,
      base_profile_id: base,
      state,
      created_by: USER_ID,
      created_at: `2026-10-2${n}T00:00:00.000Z`,
      retired_by: state === "retired" ? USER_ID : null,
      retired_at: state === "retired" ? "2026-10-27T01:00:00.000Z" : null,
    },
  };
}

export const OPTIONS: InstallationProfileOptionsResponse = {
  connections: [
    { id: "anthropic", kind: "anthropic", billing: "metered" },
    { id: "local", kind: "litellm", billing: "none" },
  ],
  runtimes: [
    {
      runtime_kind: "claude_agent_sdk",
      permission_modes: [
        "default",
        "acceptEdits",
        "plan",
        "auto",
        "bypassPermissions",
      ],
    },
  ],
  repositories: [{ id: "docs" }, { id: "platform" }],
  unattended_allowed: false,
};

export function refusal(
  status: number,
  code: string,
  details: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: String(details.reason_code ?? code),
        retryable: false,
        request_id: "req-1",
        details,
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}
