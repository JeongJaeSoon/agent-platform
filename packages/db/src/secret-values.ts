import { randomUUID } from "node:crypto";
import {
  lastFour,
  openSecret,
  type PutSecretResult,
  type SecretAadFields,
  type SecretAudit,
  type SecretKey,
  type SecretSlot,
  type SecretStore,
  type SecretSummary,
  sealSecret,
  secretOwnerRef,
} from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import { lockedRole } from "./api-keys.ts";
import { receiptActorOf } from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { receipts, secretValues, users, workspaces } from "./schema.ts";

// The SecretStore over `secret_values`. Every write of a slot runs under one
// advisory lock and the row's own lock, so a replace, a rotation and a delete
// of one slot happen one after another and versions never repeat.

type Row = typeof secretValues.$inferSelect;

// Postgres returns uuids in lowercase and the AAD and lock key are built from
// the slot, so a slot named in another case would seal what it cannot open.
const canonical = (slot: SecretSlot): SecretSlot => ({
  ...slot,
  workspaceId: slot.workspaceId.toLowerCase(),
});

const bySlot = (slot: SecretSlot) =>
  and(
    eq(secretValues.workspaceId, slot.workspaceId),
    eq(secretValues.ownerRef, secretOwnerRef(slot.owner)),
    eq(secretValues.purpose, slot.purpose),
  );

function aadOf(row: {
  id: string;
  workspaceId: string;
  ownerRef: string;
  purpose: string;
  secretVersion: number;
  keyVersion: number;
}): SecretAadFields {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerRef: row.ownerRef,
    purpose: row.purpose,
    secretVersion: row.secretVersion,
    keyVersion: row.keyVersion,
  };
}

async function lockSlot(tx: Database, slot: SecretSlot): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`secret_values:${slot.workspaceId}:${secretOwnerRef(slot.owner)}:${slot.purpose}`}))`,
  );
}

async function lockedRow(
  tx: Database,
  slot: SecretSlot,
): Promise<Row | undefined> {
  await lockSlot(tx, slot);
  const [row] = await tx
    .select()
    .from(secretValues)
    .where(bySlot(slot))
    .for("update");
  return row;
}

/** Null when the person may write; otherwise why not. */
async function auditRefusal(
  tx: Database,
  workspaceId: string,
  audit: SecretAudit,
): Promise<"actor_inactive" | "outranked" | null> {
  const userId = audit.principal.actor?.userId;
  if (!userId) return "actor_inactive";
  const role = await lockedRole(tx, workspaceId, userId);
  if (role === null) return "actor_inactive";
  return audit.roles.includes(role) ? null : "outranked";
}

function receiptRow(
  audit: SecretAudit,
  slot: SecretSlot,
  operation: "set_slack_secret" | "delete_slack_secret",
  last4: string,
) {
  return {
    id: audit.receiptId,
    ownerId: slot.workspaceId,
    actor: receiptActorOf(audit.principal),
    operation,
    targetRef: {
      resource: { kind: "workspace", id: slot.workspaceId },
      workspace_id: slot.workspaceId,
    },
    status: "succeeded" as const,
    result: { purpose: slot.purpose, last4 },
  };
}

async function summaryOf(
  db: Database,
  where: ReturnType<typeof bySlot>,
): Promise<SecretSummary | null> {
  const [row] = await db
    .select({
      last4: secretValues.last4,
      secretVersion: secretValues.secretVersion,
      updatedAt: secretValues.updatedAt,
      updatedBy: secretValues.updatedBy,
      displayName: users.displayName,
    })
    .from(secretValues)
    .leftJoin(users, eq(users.id, secretValues.updatedBy))
    .where(where);
  if (!row) return null;
  return {
    last4: row.last4,
    secretVersion: row.secretVersion,
    updatedAt: row.updatedAt,
    updatedBy:
      row.updatedBy === null || row.displayName === null
        ? null
        : { userId: row.updatedBy, displayName: row.displayName },
  };
}

export function createPostgresSecretStore(
  db: Database,
  key: SecretKey,
): SecretStore {
  function open(row: Row): string {
    return openSecret(key, aadOf(row), {
      nonce: Buffer.from(row.nonce),
      ciphertext: Buffer.from(row.ciphertext),
    });
  }

  /** Seals `value` as the next version of the slot and writes it. */
  async function write(
    tx: Database,
    slot: SecretSlot,
    current: Row | undefined,
    value: string,
    updatedBy: string | null,
  ): Promise<void> {
    const fields = aadOf({
      id: current?.id ?? randomUUID(),
      workspaceId: slot.workspaceId,
      ownerRef: secretOwnerRef(slot.owner),
      purpose: slot.purpose,
      secretVersion: (current?.secretVersion ?? 0) + 1,
      keyVersion: key.version,
    });
    const sealed = sealSecret(key, fields, value);
    const columns = {
      secretVersion: fields.secretVersion,
      keyVersion: fields.keyVersion,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      last4: lastFour(value),
      updatedBy,
      updatedAt: DB_NOW,
    };
    if (current) {
      await tx
        .update(secretValues)
        .set(columns)
        .where(eq(secretValues.id, current.id));
    } else {
      await tx.insert(secretValues).values({
        id: fields.id,
        workspaceId: fields.workspaceId,
        ownerRef: fields.ownerRef,
        purpose: fields.purpose,
        ...columns,
      });
    }
  }

  return {
    describe: (slot) => summaryOf(db, bySlot(canonical(slot))),

    async get(slot) {
      const [row] = await db
        .select()
        .from(secretValues)
        .where(bySlot(canonical(slot)));
      return row ? open(row) : null;
    },

    put(named, value, options) {
      const slot = canonical(named);
      return db.transaction(async (tx): Promise<PutSecretResult> => {
        const audit = options?.audit;
        if (audit) {
          const refused = await auditRefusal(tx, slot.workspaceId, audit);
          if (refused) return { outcome: refused };
        }
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, slot.workspaceId));
        if (!workspace) return { outcome: "workspace_not_found" };
        const current = await lockedRow(tx, slot);
        await write(
          tx,
          slot,
          current,
          value,
          audit?.principal.actor?.userId ?? null,
        );
        if (audit) {
          await tx
            .insert(receipts)
            .values(
              receiptRow(audit, slot, "set_slack_secret", lastFour(value)),
            );
        }
        const summary = await summaryOf(tx, bySlot(slot));
        if (!summary) throw new Error("secret write returned no row");
        return { outcome: "stored", summary };
      });
    },

    rotate(named, next) {
      const slot = canonical(named);
      return db.transaction(async (tx) => {
        const current = await lockedRow(tx, slot);
        if (!current) return null;
        await write(tx, slot, current, await next(open(current)), null);
        return summaryOf(tx, bySlot(slot));
      });
    },

    delete(named, options) {
      const slot = canonical(named);
      return db.transaction(async (tx) => {
        const audit = options?.audit;
        if (audit) {
          const refused = await auditRefusal(tx, slot.workspaceId, audit);
          if (refused) return { outcome: refused };
        }
        await lockSlot(tx, slot);
        const [deleted] = await tx
          .delete(secretValues)
          .where(bySlot(slot))
          .returning({ last4: secretValues.last4 });
        if (!deleted) return { outcome: "not_found" };
        if (audit) {
          await tx
            .insert(receipts)
            .values(
              receiptRow(audit, slot, "delete_slack_secret", deleted.last4),
            );
        }
        return { outcome: "deleted", last4: deleted.last4 };
      });
    },
  };
}
