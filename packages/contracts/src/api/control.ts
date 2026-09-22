import { z } from "zod";

import { revisionSchema, turnIdSchema } from "../shared/index.ts";
import { receiptAcceptedResponseSchema } from "./receipt.ts";
import { admissionStateSchema } from "./session.ts";

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
export const recoveryDecisionResultSchema = z.object({
  resulting_admission_state: admissionStateSchema,
  checkpoint_revision: revisionSchema.nullable(),
  resumable: z.boolean(),
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
export type RecoveryDecisionResult = z.infer<
  typeof recoveryDecisionResultSchema
>;
