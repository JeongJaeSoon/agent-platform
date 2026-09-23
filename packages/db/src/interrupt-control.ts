import { randomUUID } from "node:crypto";
import {
  type ControlAcceptedResponse,
  terminalTurnStatusSchema,
} from "@agent-platform/contracts";
import type {
  InterruptTurnInput,
  InterruptTurnResult,
  TurnInterrupts,
} from "@agent-platform/platform";
import { and, eq, isNull } from "drizzle-orm";
import {
  findIdempotent,
  type IdempotencyScope,
  lockIdempotencyScope,
  parseTurnSequence,
} from "./control-shared.ts";
import { dbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  controlIntents,
  idempotencyKeys,
  pendingRequests,
  receipts,
  sessions,
  turns,
} from "./schema.ts";
import { interruptReceiptResult } from "./turn-interrupts.ts";
import { OPEN_TURN_STATUSES } from "./worker-unit-of-work.ts";

const INTERRUPT = "interrupt";

export function createPostgresTurnInterrupts(db: Database): TurnInterrupts {
  return {
    interruptAtomic(input: InterruptTurnInput): Promise<InterruptTurnResult> {
      const sessionId = input.sessionId.toLowerCase();
      const scope: IdempotencyScope = {
        principal: input.principal.ownerId,
        operation: INTERRUPT,
        resource: sessionId,
        key: input.idempotencyKey,
      };
      return db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          return {
            outcome: "replayed",
            response: {
              receipt_id: existing.receiptId,
              receipt_status: existing.status,
            },
          };
        }

        // The session row lock is what finalize and the execution-gone path
        // take before they give a turn its terminal, so the turn read below
        // cannot change until this commits: either it is already terminal
        // and this is a no-op, or the intent is stored before the terminal
        // and settled by it.
        const [session] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, scope.principal),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) return { outcome: "not_found" };
        const sequence = parseTurnSequence(input.targetTurnId);
        const [turn] =
          sequence === null
            ? []
            : await tx
                .select({
                  id: turns.id,
                  sequence: turns.sequence,
                  status: turns.status,
                  attemptId: turns.attemptId,
                })
                .from(turns)
                .where(
                  and(
                    eq(turns.sessionId, sessionId),
                    eq(turns.sequence, sequence),
                  ),
                )
                .limit(1);
        if (!turn) return { outcome: "not_found" };
        if (turn.status === "queued") return { outcome: "not_started" };
        const open = OPEN_TURN_STATUSES.includes(turn.status);
        // A turn running with no attempt was handed out by the legacy pod
        // lifecycle; nothing there polls for control, so the intent would
        // wait forever.
        if (open && turn.attemptId === null) return { outcome: "unsupported" };

        const at = await dbNow(tx);
        const receiptId = randomUUID();
        const response: ControlAcceptedResponse = {
          receipt_id: receiptId,
          receipt_status: open ? "accepted" : "succeeded",
        };
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: scope.principal,
          operation: INTERRUPT,
          targetRef: {
            session_id: sessionId,
            turn_id: String(turn.sequence),
            request_id: null,
          },
          status: response.receipt_status,
          // A turn that already ended answers at once, naming how it ended.
          result: open
            ? null
            : interruptReceiptResult(
                turn.sequence,
                terminalTurnStatusSchema.parse(turn.status),
                false,
              ),
          createdAt: at,
          updatedAt: at,
        });
        if (open) {
          await tx.insert(controlIntents).values({
            id: randomUUID(),
            sessionId,
            kind: INTERRUPT,
            targetTurnId: turn.id,
            attemptId: turn.attemptId,
            receiptId,
            issuedAt: at,
          });
          // An answer given from here on would reach a turn that is being
          // stopped; the requests close now, and the worker cancels the
          // callbacks it still holds.
          await tx
            .update(pendingRequests)
            .set({ resolvedAt: at })
            .where(
              and(
                eq(pendingRequests.turnId, turn.id),
                isNull(pendingRequests.resolvedAt),
              ),
            );
        }
        await tx.insert(idempotencyKeys).values({
          principal: scope.principal,
          operation: scope.operation,
          resource: scope.resource,
          key: scope.key,
          payloadHash: input.payloadHash,
          receiptId,
        });
        return { outcome: "accepted", response };
      });
    },
  };
}
