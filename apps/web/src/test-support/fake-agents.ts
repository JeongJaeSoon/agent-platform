import type {
  AgentCard,
  AgentDetail,
  AgentRelease,
  AgentVersion,
} from "@agent-platform/contracts";
import { apiError, json, USER_ID, WORKSPACE_ID } from "./fake-api.ts";

export const AGENT_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const VERSION_IDS = [
  "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e",
  "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  "8d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a",
];

export const CARD: AgentCard = {
  role: "결제 문의 담당",
  instructions: "결제 문의에 답한다.",
  language: "ko",
  model: "claude-sonnet-5",
  capabilities: { tools: null, mcp: null, forbidden: [] },
  rules: [],
};

const sha = (n: number) => n.toString(16).padStart(64, "0");

/**
 * The agents API as one stateful server: two tabs on the same server see
 * each other's writes, and activation is a compare-and-swap on the revision
 * exactly as the real route does it.
 */
export function agentServer() {
  const versions: AgentVersion[] = [version(1, CARD)];
  const releases: AgentRelease[] = [];
  let active: string | null = null;
  let revision = -1;

  function version(no: number, card: AgentCard): AgentVersion {
    return {
      id: VERSION_IDS[no - 1] ?? crypto.randomUUID(),
      agent_id: AGENT_ID,
      version_no: no,
      card,
      content_sha256: sha(no),
      created_by: USER_ID,
      created_at: `2026-10-11T00:0${no}:00.000Z`,
    };
  }

  function detail(): AgentDetail {
    return {
      agent: {
        id: AGENT_ID,
        workspace_id: WORKSPACE_ID,
        slug: "billing",
        name: "결제 담당",
        status: "active",
        active_release_id: active,
        activation_revision: revision,
        created_by: USER_ID,
        created_at: "2026-10-11T00:00:00.000Z",
        updated_at: "2026-10-11T00:00:00.000Z",
      },
      versions: [...versions],
      releases: [...releases],
      active_release: releases.find((r) => r.id === active) ?? null,
    };
  }

  const path = `/v1/agents/${AGENT_ID}`;
  const routes = {
    "GET /v1/agents": () => json(200, { items: [detail().agent] }),
    [`GET ${path}`]: () => json(200, detail()),
    [`GET ${path}/admins`]: () => json(200, { users: [], teams: [] }),
    [`PATCH ${path}`]: async (request: Request) => {
      const body = (await request.json()) as { card?: AgentCard };
      const card = body.card;
      if (
        card &&
        !versions.some((v) => JSON.stringify(v.card) === JSON.stringify(card))
      )
        versions.push(version(versions.length + 1, card));
      return json(200, detail());
    },
    [`POST ${path}/releases`]: async (request: Request) => {
      const body = (await request.json()) as {
        version_id: string;
        runtime_profile_id: string;
      };
      if (body.runtime_profile_id !== "claude-coding-local")
        return apiError(
          422,
          "UNSUPPORTED_CAPABILITY",
          `Unknown runtime profile ${body.runtime_profile_id}`,
        );
      const id = `rel-${body.version_id.slice(0, 8)}`;
      const existing = releases.find((r) => r.id === id);
      if (existing) return json(200, { release: existing, created: false });
      const release: AgentRelease = {
        id,
        agent_id: AGENT_ID,
        version_id: body.version_id,
        card_sha256: sha(releases.length + 10),
        runtime_profile_id: body.runtime_profile_id,
        profile_digest: "digest-1",
        runtime_config_snapshot: {},
        effective_tools: { tools: ["Read"], mcp: [] },
        policy_pins: {},
        created_by: USER_ID,
        created_at: `2026-10-11T01:0${releases.length}:00.000Z`,
        approved_by: null,
        approved_at: null,
      };
      releases.push(release);
      return json(200, { release, created: true });
    },
    [`POST ${path}/activate`]: async (request: Request) => {
      const body = (await request.json()) as {
        release_id: string;
        expected_revision: number;
      };
      if (body.expected_revision !== revision)
        return apiError(
          409,
          "REVISION_CONFLICT",
          "The agent was activated by someone else",
        );
      const previous = active;
      if (previous === body.release_id)
        return json(200, {
          active_release_id: previous,
          previous_release_id: previous,
          activation_revision: revision,
          receipt_id: null,
        });
      active = body.release_id;
      revision += 1;
      return json(200, {
        active_release_id: active,
        previous_release_id: previous,
        activation_revision: revision,
        receipt_id: crypto.randomUUID(),
      });
    },
  };

  return { routes, detail, versions, releases };
}
