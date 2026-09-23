import { z } from "zod";

import { revisionSchema, turnIdSchema } from "../shared/index.ts";
import { receiptAcceptedResponseSchema } from "./receipt.ts";
import { admissionStateSchema, terminalTurnStatusSchema } from "./session.ts";

export const RECOVERY_DECISION_VALUES = [
  "abandon",
  "confirm_completed",
  "close",
] as const;
export const recoveryDecisionSchema = z.enum(RECOVERY_DECISION_VALUES);

export const interruptSessionRequestSchema = z
  .object({ target_turn_id: turnIdSchema })
  .strict();
export const pauseSessionRequestSchema = z
  .object({
    expected_revision: revisionSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
export const terminateSessionRequestSchema = pauseSessionRequestSchema;
export const resumeSessionRequestSchema = z
  .object({ expected_revision: revisionSchema })
  .strict();
const recoveryDecisionBase = {
  expected_revision: revisionSchema,
  reason: z.string().min(1),
};
export const recoveryDecisionRequestSchema = z.discriminatedUnion("decision", [
  z
    .object({
      ...recoveryDecisionBase,
      decision: z.literal("abandon"),
      target_turn_id: turnIdSchema,
    })
    .strict(),
  z
    .object({
      ...recoveryDecisionBase,
      decision: z.literal("confirm_completed"),
      target_turn_id: turnIdSchema,
      evidence_ref: z.string().min(1),
    })
    .strict(),
  z.object({ ...recoveryDecisionBase, decision: z.literal("close") }).strict(),
]);
export const controlAcceptedResponseSchema = receiptAcceptedResponseSchema;
// The 202 itself says that a kill undoes nothing the execution already did
// outside; the receipt repeats it once the kill is observed.
export const terminateSessionResponseSchema = receiptAcceptedResponseSchema
  .extend({ external_effects_reverted: z.literal(false) })
  .strict();
// What an interrupt receipt settles with: the terminal the target turn
// actually reached. `no_op` is true when that terminal was not the
// interrupt's doing — the turn had already ended when it was asked, or ended
// on its own first — and false for `interrupted` and for `outcome_unknown`
// reached while it was pending, where nobody can say.
export const interruptReceiptResultSchema = z.object({
  turn_id: turnIdSchema,
  terminal: terminalTurnStatusSchema,
  no_op: z.boolean(),
});
// The receipt result of a recovery decision (api.md § recovery 결정 후
// 상태). `resumable` is false whenever the session has no committed
// checkpoint at all: a resume would then be refused CHECKPOINT_UNAVAILABLE.
export const recoveryDecisionResultSchema = z.object({
  resulting_admission_state: admissionStateSchema,
  checkpoint_revision: revisionSchema.nullable(),
  resumable: z.boolean(),
});
// What a resume from `stopped` commits: the session is admitting input
// again and the next worker restores this revision. Restore success itself
// is reported by the worker path (94S-246), not by this receipt.
export const resumeReceiptResultSchema = z.object({
  resulting_admission_state: admissionStateSchema,
  checkpoint_revision: revisionSchema,
  queued_turn_count: z.number().int().nonnegative(),
});

export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;
export type InterruptSessionRequest = z.infer<
  typeof interruptSessionRequestSchema
>;
export type PauseSessionRequest = z.infer<typeof pauseSessionRequestSchema>;
export type TerminateSessionRequest = z.infer<
  typeof terminateSessionRequestSchema
>;
export type ResumeSessionRequest = z.infer<typeof resumeSessionRequestSchema>;
export type RecoveryDecisionRequest = z.infer<
  typeof recoveryDecisionRequestSchema
>;
export type ControlAcceptedResponse = z.infer<
  typeof controlAcceptedResponseSchema
>;
export type TerminateSessionResponse = z.infer<
  typeof terminateSessionResponseSchema
>;
export type InterruptReceiptResult = z.infer<
  typeof interruptReceiptResultSchema
>;
export type RecoveryDecisionResult = z.infer<
  typeof recoveryDecisionResultSchema
>;
export type ResumeReceiptResult = z.infer<typeof resumeReceiptResultSchema>;
