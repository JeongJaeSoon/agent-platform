import { createHash } from "node:crypto";
import type { CommitAttributionLedger } from "@werft-ai/platform";
import type { AttributionExpectation } from "@werft-ai/runtime-core";
import { asc, eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { sessionCommitAttributions } from "./schema.ts";

export function expectationDigest(expectation: AttributionExpectation) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        expectation.author.name,
        expectation.author.email,
        expectation.coAuthor?.name ?? null,
        expectation.coAuthor?.email ?? null,
        expectation.agentSession,
      ]),
    )
    .digest("hex");
}

export function createPostgresCommitAttributionLedger(
  db: Database,
): CommitAttributionLedger {
  return {
    async record(rawSessionId, expectation) {
      await db
        .insert(sessionCommitAttributions)
        .values({
          sessionId: rawSessionId.toLowerCase(),
          digest: expectationDigest(expectation),
          authorName: expectation.author.name,
          authorEmail: expectation.author.email,
          coAuthorName: expectation.coAuthor?.name ?? null,
          coAuthorEmail: expectation.coAuthor?.email ?? null,
          agentSession: expectation.agentSession,
        })
        .onConflictDoNothing();
    },
    async list(rawSessionId) {
      const rows = await db
        .select()
        .from(sessionCommitAttributions)
        .where(
          eq(sessionCommitAttributions.sessionId, rawSessionId.toLowerCase()),
        )
        .orderBy(asc(sessionCommitAttributions.createdAt));
      return rows.map((row) => ({
        author: { name: row.authorName, email: row.authorEmail },
        coAuthor:
          row.coAuthorName === null || row.coAuthorEmail === null
            ? null
            : { name: row.coAuthorName, email: row.coAuthorEmail },
        agentSession: row.agentSession,
      }));
    },
  };
}
