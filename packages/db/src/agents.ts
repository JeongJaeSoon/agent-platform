import { randomUUID } from "node:crypto";
import {
  type Agent,
  type AgentDetail,
  type AgentRelease,
  type AgentVersion,
  agentCardSchema,
  agentReleaseSchema,
  type ReceiptOperation,
} from "@agent-platform/contracts";
import type {
  ActivateResult,
  AgentStore,
  Principal,
} from "@agent-platform/platform";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { actorStillMember, receiptActorOf } from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  agentActivationEvents,
  agentAdmins,
  agentReleases,
  agents,
  agentVersions,
  receipts,
} from "./schema.ts";

type AgentRow = typeof agents.$inferSelect;
type VersionRow = typeof agentVersions.$inferSelect;
type ReleaseRow = typeof agentReleases.$inferSelect;

export function agentOf(row: AgentRow): Agent {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    slug: row.slug,
    name: row.name,
    status: row.status as Agent["status"],
    active_release_id: row.activeReleaseId,
    activation_revision: row.activationRevision,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function versionOf(row: VersionRow): AgentVersion {
  return {
    id: row.id,
    agent_id: row.agentId,
    version_no: row.versionNo,
    card: agentCardSchema.parse(row.card),
    content_sha256: row.contentSha256,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  };
}

function releaseOf(row: ReleaseRow): AgentRelease {
  return agentReleaseSchema.parse({
    id: row.id,
    agent_id: row.agentId,
    version_id: row.versionId,
    card_sha256: row.cardSha256,
    runtime_profile_id: row.runtimeProfileId,
    profile_digest: row.profileDigest,
    runtime_config_snapshot: row.runtimeConfigSnapshot,
    effective_tools: row.effectiveTools,
    policy_pins: row.policyPins,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    approved_by: row.approvedBy,
    approved_at: row.approvedAt?.toISOString() ?? null,
  });
}

async function detailOf(
  db: Database,
  workspaceId: string,
  agentId: string,
): Promise<AgentDetail | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  if (!agent) return null;
  const versions = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agent.id))
    .orderBy(asc(agentVersions.versionNo));
  const releases = (
    await db
      .select()
      .from(agentReleases)
      .where(eq(agentReleases.agentId, agent.id))
      .orderBy(asc(agentReleases.createdAt), asc(agentReleases.id))
  ).map(releaseOf);
  return {
    agent: agentOf(agent),
    versions: versions.map(versionOf),
    releases,
    active_release:
      releases.find((release) => release.id === agent.activeReleaseId) ?? null,
  };
}

async function writeReceipt(
  tx: Database,
  principal: Principal,
  input: {
    operation: ReceiptOperation;
    workspaceId: string;
    agentId: string;
    result?: unknown;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: principal.ownerId,
    actor: receiptActorOf(principal),
    operation: input.operation,
    targetRef: {
      resource: { kind: "agent", id: input.agentId },
      workspace_id: input.workspaceId,
    },
    status: "succeeded",
    result: input.result ?? null,
  });
  return id;
}

async function lockAgent(tx: Database, workspaceId: string, agentId: string) {
  const [agent] = await tx
    .select({
      id: agents.id,
      activeReleaseId: agents.activeReleaseId,
      activationRevision: agents.activationRevision,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1)
    .for("update");
  return agent;
}

export function createPostgresAgentStore(db: Database): AgentStore {
  return {
    async list(workspaceId, limit) {
      const rows = await db
        .select()
        .from(agents)
        .where(eq(agents.workspaceId, workspaceId))
        .orderBy(asc(agents.createdAt), asc(agents.id))
        .limit(limit);
      return rows.map(agentOf);
    },

    get: (workspaceId, agentId) => detailOf(db, workspaceId, agentId),

    async findVersion(workspaceId, agentId, versionId) {
      const [row] = await db
        .select({ version: agentVersions })
        .from(agentVersions)
        .innerJoin(agents, eq(agents.id, agentVersions.agentId))
        .where(
          and(
            eq(agentVersions.id, versionId),
            eq(agents.id, agentId),
            eq(agents.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      return row ? versionOf(row.version) : null;
    },

    async findRelease(workspaceId, releaseId) {
      const [row] = await db
        .select({ release: agentReleases })
        .from(agentReleases)
        .innerJoin(agents, eq(agents.id, agentReleases.agentId))
        .where(
          and(
            eq(agentReleases.id, releaseId),
            eq(agents.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      return row ? releaseOf(row.release) : null;
    },

    create(input) {
      return db.transaction(async (tx) => {
        if (!(await actorStillMember(tx, input.principal))) {
          return { outcome: "actor_inactive" };
        }
        const agentId = randomUUID();
        const inserted = await tx
          .insert(agents)
          .values({
            id: agentId,
            workspaceId: input.workspaceId,
            slug: input.slug,
            name: input.name,
            createdBy: input.createdBy,
          })
          .onConflictDoNothing({
            target: [agents.workspaceId, agents.slug],
          })
          .returning({ id: agents.id });
        if (inserted.length === 0) return { outcome: "slug_taken" };
        await tx.insert(agentVersions).values({
          id: randomUUID(),
          agentId,
          versionNo: 1,
          card: input.card,
          contentSha256: input.contentSha256,
          createdBy: input.createdBy,
        });
        // D3: whoever creates an agent administers it.
        await tx.insert(agentAdmins).values({
          workspaceId: input.workspaceId,
          agentId,
          userId: input.createdBy,
          createdBy: input.createdBy,
        });
        await writeReceipt(tx, input.principal, {
          operation: "create_agent",
          workspaceId: input.workspaceId,
          agentId,
        });
        const detail = await detailOf(tx, input.workspaceId, agentId);
        if (!detail) throw new Error(`agent ${agentId} vanished in its tx`);
        return { outcome: "created", detail };
      });
    },

    update(input) {
      return db.transaction(async (tx) => {
        if (!(await actorStillMember(tx, input.principal))) {
          return { outcome: "actor_inactive" };
        }
        const agent = await lockAgent(tx, input.workspaceId, input.agentId);
        if (!agent) return { outcome: "not_found" };
        let changed = false;
        if (input.name !== undefined) {
          const renamed = await tx
            .update(agents)
            .set({ name: input.name, updatedAt: DB_NOW })
            .where(
              and(
                eq(agents.id, agent.id),
                sql`${agents.name} IS DISTINCT FROM ${input.name}`,
              ),
            )
            .returning({ id: agents.id });
          changed ||= renamed.length > 0;
        }
        if (input.card !== undefined) {
          const [latest] = await tx
            .select({ versionNo: max(agentVersions.versionNo) })
            .from(agentVersions)
            .where(eq(agentVersions.agentId, agent.id));
          const added = await tx
            .insert(agentVersions)
            .values({
              id: randomUUID(),
              agentId: agent.id,
              versionNo: (latest?.versionNo ?? 0) + 1,
              card: input.card.card,
              contentSha256: input.card.contentSha256,
              createdBy: input.updatedBy,
            })
            .onConflictDoNothing({
              target: [agentVersions.agentId, agentVersions.contentSha256],
            })
            .returning({ id: agentVersions.id });
          if (added.length > 0) {
            changed = true;
            await tx
              .update(agents)
              .set({ updatedAt: DB_NOW })
              .where(eq(agents.id, agent.id));
          }
        }
        if (changed) {
          await writeReceipt(tx, input.principal, {
            operation: "update_agent",
            workspaceId: input.workspaceId,
            agentId: agent.id,
          });
        }
        const detail = await detailOf(tx, input.workspaceId, agent.id);
        if (!detail) throw new Error(`agent ${agent.id} vanished in its tx`);
        return { outcome: "updated", detail };
      });
    },

    insertRelease(input) {
      const { release } = input;
      return db.transaction(async (tx) => {
        if (!(await actorStillMember(tx, input.principal))) {
          return { outcome: "actor_inactive" };
        }
        const [owned] = await tx
          .select({ id: agentVersions.id })
          .from(agentVersions)
          .innerJoin(agents, eq(agents.id, agentVersions.agentId))
          .where(
            and(
              eq(agentVersions.id, release.version_id),
              eq(agents.id, release.agent_id),
              eq(agents.workspaceId, input.workspaceId),
            ),
          )
          .limit(1);
        if (!owned) return { outcome: "not_found" };
        const [inserted] = await tx
          .insert(agentReleases)
          .values({
            id: release.id,
            agentId: release.agent_id,
            versionId: release.version_id,
            cardSha256: release.card_sha256,
            runtimeProfileId: release.runtime_profile_id,
            profileDigest: release.profile_digest,
            runtimeConfigSnapshot: release.runtime_config_snapshot,
            effectiveTools: release.effective_tools,
            policyPins: release.policy_pins,
            createdBy: release.created_by,
          })
          .onConflictDoNothing({ target: agentReleases.id })
          .returning();
        if (!inserted) {
          const [existing] = await tx
            .select()
            .from(agentReleases)
            .where(eq(agentReleases.id, release.id))
            .limit(1);
          if (!existing) throw new Error(`release ${release.id} vanished`);
          return { outcome: "exists", release: releaseOf(existing) };
        }
        const receiptId = await writeReceipt(tx, input.principal, {
          operation: "create_agent_release",
          workspaceId: input.workspaceId,
          agentId: release.agent_id,
          result: { release_id: release.id },
        });
        await tx.insert(agentActivationEvents).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          agentId: release.agent_id,
          kind: "release_created",
          releaseId: release.id,
          actorUserId: release.created_by,
          actor: receiptActorOf(input.principal),
          receiptId,
        });
        return { outcome: "created", release: releaseOf(inserted) };
      });
    },

    activate(input): Promise<ActivateResult> {
      return db.transaction(async (tx) => {
        if (!(await actorStillMember(tx, input.principal))) {
          return { outcome: "actor_inactive" };
        }
        // The lock queues concurrent activations; the UPDATE below is the
        // compare-and-swap each of them is then judged by.
        const agent = await lockAgent(tx, input.workspaceId, input.agentId);
        if (!agent) return { outcome: "not_found" };
        const current = agent.activationRevision;
        // expected + 1: a retry of a request whose first attempt already swapped.
        if (
          agent.activeReleaseId === input.releaseId &&
          (current === input.expectedRevision ||
            current === input.expectedRevision + 1)
        ) {
          return {
            outcome: "unchanged",
            revision: current,
            previousReleaseId: null,
          };
        }
        const [swapped] = await tx
          .update(agents)
          .set({
            activeReleaseId: input.releaseId,
            activationRevision: sql`${agents.activationRevision} + 1`,
            updatedAt: DB_NOW,
          })
          .where(
            and(
              eq(agents.id, agent.id),
              eq(agents.activationRevision, input.expectedRevision),
            ),
          )
          .returning({ revision: agents.activationRevision });
        if (!swapped) {
          return {
            outcome: "conflict",
            activeReleaseId: agent.activeReleaseId,
            revision: current,
          };
        }
        await tx
          .update(agentReleases)
          .set({ approvedBy: input.approvedBy, approvedAt: DB_NOW })
          .where(
            and(
              eq(agentReleases.id, input.releaseId),
              sql`${agentReleases.approvedBy} IS NULL`,
            ),
          );
        const receiptId = await writeReceipt(tx, input.principal, {
          operation: "activate_agent",
          workspaceId: input.workspaceId,
          agentId: agent.id,
          result: {
            release_id: input.releaseId,
            previous_release_id: agent.activeReleaseId,
            activation_revision: swapped.revision,
          },
        });
        await tx.insert(agentActivationEvents).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          agentId: agent.id,
          kind: "activated",
          releaseId: input.releaseId,
          previousReleaseId: agent.activeReleaseId,
          activationRevision: swapped.revision,
          actorUserId: input.approvedBy,
          actor: receiptActorOf(input.principal),
          receiptId,
        });
        return {
          outcome: "activated",
          revision: swapped.revision,
          previousReleaseId: agent.activeReleaseId,
          receiptId,
        };
      });
    },
  };
}
