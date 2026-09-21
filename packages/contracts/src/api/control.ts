import { z } from "zod/v4";

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
export const recoveryDecisionRequestSchema = z
  .object({
    expected_revision: revisionSchema,
    decision: recoveryDecisionSchema,
    target_turn_id: turnIdSchema.optional(),
    evidence_ref: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.decision !== "close" && request.target_turn_id === undefined) {
      context.addIssue({
        code: "custom",
        message: "abandon and confirm_completed target a turn",
        path: ["target_turn_id"],
      });
    }
    if (
      request.decision === "confirm_completed" &&
      request.evidence_ref === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "confirm_completed requires verified evidence",
        path: ["evidence_ref"],
      });
    }
  });
export const controlAcceptedResponseSchema = receiptAcceptedResponseSchema;
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
export type RecoveryDecisionResult = z.infer<
  typeof recoveryDecisionResultSchema
>;
