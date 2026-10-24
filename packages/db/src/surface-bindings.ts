import { randomUUID } from "node:crypto";
import {
  DEFAULT_SURFACE_CEILING,
  type SlackSurfaceAction,
} from "@werft-ai/contracts";
import type {
  Principal,
  SetSurfaceBindingResult,
  SurfaceBindingRecord,
  SurfaceBindingStore,
} from "@werft-ai/platform";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { callerHoldsRight } from "./agent-identities.ts";
import { receiptActorOf } from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  agentIdentities,
  agents,
  receipts,
  surfaceBindings,
} from "./schema.ts";

// Lock order: the actor's membership, the agent, its identity, then the
// binding rows, as the identity store takes the install before its rows.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIVE_UNIQUE_INDEXES = new Set([
  "surface_bindings_channel_live_uniq",
  "surface_bindings_dm_live_uniq",
  "surface_bindings_home_live_uniq",
]);

const columns = {
  id: surfaceBindings.id,
  workspaceId: surfaceBindings.workspaceId,
  agentId: surfaceBindings.agentId,
  installationId: surfaceBindings.installationId,
  channelId: surfaceBindings.externalSurfaceId,
  channelKind: surfaceBindings.surfaceKind,
  mode: surfaceBindings.mode,
  ceilingActions: surfaceBindings.ceilingActions,
  ceilingDisclosure: surfaceBindings.ceilingDisclosure,
  home: surfaceBindings.home,
  memoryWritePolicy: surfaceBindings.memoryWritePolicy,
  status: surfaceBindings.status,
  muted: surfaceBindings.muted,
  revision: surfaceBindings.revision,
  createdAt: surfaceBindings.createdAt,
  revokedAt: surfaceBindings.revokedAt,
};

type Row = Omit<SurfaceBindingRecord, "ceiling"> & {
  ceilingActions: string[];
  ceilingDisclosure: SurfaceBindingRecord["ceiling"]["disclosure"];
};

function recordOf(row: Row): SurfaceBindingRecord {
  const { ceilingActions, ceilingDisclosure, ...rest } = row;
  return {
    ...rest,
    // The ceiling check keeps the column inside the Slack actions.
    ceiling: {
      actions: ceilingActions as SlackSurfaceAction[],
      disclosure: ceilingDisclosure,
    },
  };
}

function channelOf(installationId: string, channelId: string | null) {
  return and(
    eq(surfaceBindings.installationId, installationId),
    channelId === null
      ? eq(surfaceBindings.surfaceKind, "dm")
      : eq(surfaceBindings.externalSurfaceId, channelId),
    isNull(surfaceBindings.revokedAt),
  );
}

// Two writes racing to one channel, the DM row or the home: a live index
// refuses the second. drizzle wraps the driver's error, so the code may sit
// on its cause.
function isLiveConflict(error: unknown): boolean {
  for (let e = error; typeof e === "object" && e !== null; ) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === "23505") {
      return (
        typeof constraint === "string" && LIVE_UNIQUE_INDEXES.has(constraint)
      );
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

async function writeReceipt(
  tx: Database,
  principal: Principal,
  binding: SurfaceBindingRecord,
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: binding.workspaceId,
    actor: receiptActorOf(principal),
    requestId: principal.requestId ?? null,
    operation: "set_surface_binding",
    targetRef: {
      resource: { kind: "surface_binding", id: binding.id },
      workspace_id: binding.workspaceId,
    },
    status: "succeeded",
    result: {
      surface_binding_id: binding.id,
      agent_id: binding.agentId,
      installation_id: binding.installationId,
      channel_id: binding.channelId,
      channel_kind: binding.channelKind,
      mode: binding.mode,
      home: binding.home,
      ceiling: binding.ceiling,
      revision: binding.revision,
    },
  });
  return id;
}

async function set(
  db: Database,
  input: Parameters<SurfaceBindingStore["set"]>[0],
): Promise<SetSurfaceBindingResult> {
  const { workspaceId } = input;
  if (!UUID.test(input.agentId)) return { outcome: "agent_not_found" };
  const agentId = input.agentId.toLowerCase();
  try {
    return await db.transaction(async (tx) => {
      const right = await callerHoldsRight(
        tx,
        input.principal,
        workspaceId,
        agentId,
        input.managerRoles,
      );
      if ("outcome" in right) return right;
      const [agent] = await tx
        .select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
        .limit(1)
        .for("key share");
      if (!agent || agent.status === "archived") {
        return { outcome: "agent_not_found" };
      }
      // A revoke of the identity waits for this write, and this write sees
      // a revoke that committed first.
      const [identity] = await tx
        .select({ installationId: agentIdentities.installationId })
        .from(agentIdentities)
        .where(
          and(
            eq(agentIdentities.agentId, agentId),
            eq(agentIdentities.workspaceId, workspaceId),
            eq(agentIdentities.status, "active"),
          ),
        )
        // Several live installs have no selector in the request yet; the
        // newest is the one written, every time.
        .orderBy(desc(agentIdentities.createdAt), desc(agentIdentities.id))
        .limit(1)
        .for("share");
      if (!identity) return { outcome: "not_installed" };
      const { installationId } = identity;

      const [current] = await tx
        .select({ id: surfaceBindings.id, agentId: surfaceBindings.agentId })
        .from(surfaceBindings)
        .where(channelOf(installationId, input.channelId))
        .limit(1)
        .for("update");
      // Revoking an identity revokes its bindings, so a live row of another
      // agent is one written before that rule; it is never this caller's.
      if (current && current.agentId !== agentId) {
        return { outcome: "conflict" };
      }
      if (input.home) {
        await tx
          .update(surfaceBindings)
          .set({
            home: false,
            revision: sql`${surfaceBindings.revision} + 1`,
            updatedAt: DB_NOW,
          })
          .where(
            and(
              eq(surfaceBindings.agentId, agentId),
              eq(surfaceBindings.home, true),
              isNull(surfaceBindings.revokedAt),
              ...(current ? [ne(surfaceBindings.id, current.id)] : []),
            ),
          );
      }
      const values = {
        surfaceKind: input.channelKind,
        mode: input.mode,
        home: input.home,
        ceilingActions: [...input.ceiling.actions],
        ceilingDisclosure: input.ceiling.disclosure,
        updatedAt: DB_NOW,
      };
      const id = current?.id ?? randomUUID();
      if (current) {
        await tx
          .update(surfaceBindings)
          .set({ ...values, revision: sql`${surfaceBindings.revision} + 1` })
          .where(eq(surfaceBindings.id, id));
      } else {
        await tx.insert(surfaceBindings).values({
          ...values,
          id,
          workspaceId,
          agentId,
          surface: "slack",
          installationId,
          externalSurfaceId: input.channelId,
          createdBy: right.userId,
          createdAt: DB_NOW,
        });
      }
      const [row] = await tx
        .select(columns)
        .from(surfaceBindings)
        .where(eq(surfaceBindings.id, id));
      if (!row) throw new Error(`surface binding ${id} vanished in its tx`);
      const binding = recordOf(row);
      const receiptId = await writeReceipt(tx, input.principal, binding);
      return { outcome: "set", binding, receiptId };
    });
  } catch (error) {
    if (isLiveConflict(error)) return { outcome: "conflict" };
    throw error;
  }
}

export function createPostgresSurfaceBindingStore(
  db: Database,
): SurfaceBindingStore {
  return {
    set: (input) => set(db, input),
    async list(workspaceId, agentId, limit) {
      if (!UUID.test(agentId) || !UUID.test(workspaceId)) return [];
      const rows = await db
        .select(columns)
        .from(surfaceBindings)
        .where(
          and(
            eq(surfaceBindings.workspaceId, workspaceId),
            eq(surfaceBindings.agentId, agentId.toLowerCase()),
            isNull(surfaceBindings.revokedAt),
          ),
        )
        .orderBy(
          desc(surfaceBindings.home),
          asc(surfaceBindings.createdAt),
          asc(surfaceBindings.id),
        )
        .limit(limit);
      return rows.map(recordOf);
    },
    resolveSlackChannel: (installationId, channelId) =>
      resolveSlackChannel(db, installationId, channelId),
    async ensureDmBinding(installationId) {
      if (!UUID.test(installationId)) return null;
      const id = installationId.toLowerCase();
      const [live] = await db
        .select({ id: surfaceBindings.id })
        .from(surfaceBindings)
        .where(channelOf(id, null))
        .limit(1);
      if (!live) {
        const { actions, disclosure } = DEFAULT_SURFACE_CEILING;
        await db.execute(sql`
          INSERT INTO ${surfaceBindings} (id, workspace_id, agent_id, surface,
            installation_id, surface_kind, mode, ceiling_actions,
            ceiling_disclosure)
          SELECT ${randomUUID()}, i.workspace_id, i.agent_id, 'slack',
            i.installation_id, 'dm', 'mention',
            ARRAY[${sql.join(
              actions.map((action) => sql`${action}`),
              sql`, `,
            )}]::text[], ${disclosure}
          FROM ${agentIdentities} i
          WHERE i.installation_id = ${id} AND i.status = 'active'
          ON CONFLICT DO NOTHING`);
      }
      return resolveSlackChannel(db, id, null);
    },
  };
}

async function resolveSlackChannel(
  db: Database,
  installationId: string,
  channelId: string | null,
): Promise<SurfaceBindingRecord | null> {
  if (!UUID.test(installationId)) return null;
  const [row] = await db
    .select(columns)
    .from(surfaceBindings)
    .where(
      and(
        channelOf(installationId.toLowerCase(), channelId),
        eq(surfaceBindings.status, "ready"),
      ),
    )
    .limit(1);
  return row ? recordOf(row) : null;
}
