import { eq } from "drizzle-orm";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { catalogAuthority } from "./schema.ts";

export type CatalogAuthority = { revision: string; activatedAt: Date };

export type ActivateCatalogResult =
  | { outcome: "activated"; authority: CatalogAuthority }
  // The revision active now is not the one the operator expected to replace.
  | { outcome: "conflict"; current: CatalogAuthority | null };

const AUTHORITY_ID = 1;

/** The revision an operator activated, or null while none is (94S-295). */
export async function activeCatalogRevision(
  db: Database,
): Promise<CatalogAuthority | null> {
  const [row] = await db
    .select({
      revision: catalogAuthority.revision,
      activatedAt: catalogAuthority.activatedAt,
    })
    .from(catalogAuthority)
    .where(eq(catalogAuthority.id, AUTHORITY_ID))
    .limit(1);
  return row ?? null;
}

/**
 * Makes `revision` the one catalog whose gateways may fail a session for a
 * pair it lacks, provided `expected` is still the active one (null: none
 * is). A compare-and-swap, so two operators — or a rollout script and a
 * rollback — cannot silently overwrite each other's decision.
 */
export async function activateCatalogRevision(
  db: Database,
  input: { revision: string; expected: string | null },
): Promise<ActivateCatalogResult> {
  const returning = {
    revision: catalogAuthority.revision,
    activatedAt: catalogAuthority.activatedAt,
  };
  const [activated] =
    input.expected === null
      ? await db
          .insert(catalogAuthority)
          .values({
            id: AUTHORITY_ID,
            revision: input.revision,
            activatedAt: DB_NOW,
          })
          .onConflictDoNothing({ target: catalogAuthority.id })
          .returning(returning)
      : await db
          .update(catalogAuthority)
          .set({ revision: input.revision, activatedAt: DB_NOW })
          .where(eq(catalogAuthority.revision, input.expected))
          .returning(returning);
  if (activated) return { outcome: "activated", authority: activated };
  return { outcome: "conflict", current: await activeCatalogRevision(db) };
}
