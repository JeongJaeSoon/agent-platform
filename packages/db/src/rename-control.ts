import type {
  RenameSessionInput,
  RenameSessionResult,
} from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import {
  controlClock,
  lockSessionForControl,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { dbNow } from "./db-clock.ts";
import { awaitingInputAt, publicStatus } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { sessions } from "./schema.ts";
import { recordStatus } from "./session-events.ts";

export function renameAtomic(
  db: Database,
  input: RenameSessionInput,
): Promise<RenameSessionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const startedAt = Date.now();
  return transactionWithBindingRetry(db, async (tx, attempt) => {
    // The events writer's lock: the status event below takes its id under it.
    const session = await lockSessionForControl(tx, {
      sessionId,
      ownerId: input.principal.ownerId,
      attempt,
    });
    if (!session) return { outcome: "not_found" };
    if (session.title === input.title) {
      return { outcome: "renamed", changed: false };
    }
    const now = controlClock(input.now, startedAt);
    await tx
      .update(sessions)
      .set({ title: input.title, updatedAt: now })
      .where(eq(sessions.id, sessionId));
    const at = await dbNow(tx);
    await recordStatus(tx, {
      sessionId,
      phase: publicStatus(
        session.status,
        await awaitingInputAt(tx, sessionId, at),
      ),
      extra: {
        admission_state: session.admissionState,
        title: input.title,
        actor: { owner_id: input.principal.ownerId },
      },
      turnRowId: null,
      now,
    });
    return { outcome: "renamed", changed: true };
  });
}
