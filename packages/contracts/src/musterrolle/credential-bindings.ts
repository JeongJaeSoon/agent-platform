import { z } from "zod";

import { credentialRefSchema } from "../kollegium/agents.ts";
import { agentIdSchema, userIdSchema } from "../shared/index.ts";

/**
 * What a requester whose session could not start reads (design 4.4, D11):
 * no credential names, which are the admins' to fix, only who to ask.
 */
export const CREDENTIAL_UNBOUND_GUIDANCE =
  "연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요";

export const agentContactSchema = z
  .object({
    user_id: userIdSchema,
    display_name: z.string(),
    email: z.string(),
  })
  .strict();

/** `details` of a 409 CREDENTIAL_UNBOUND from POST /v1/sessions. */
export const sessionCredentialUnboundDetailsSchema = z
  .object({
    reason_code: z.literal("credential_unbound"),
    guidance: z.literal(CREDENTIAL_UNBOUND_GUIDANCE),
    agent_id: agentIdSchema,
    /** The agent's admins, or its workspace's owners and admins when none is left. */
    admins: z.array(agentContactSchema),
    /** A `mailto:` link to every admin above; null when there is no one. */
    admin_link: z.string().nullable(),
  })
  .strict();

/** `details` of a 409 CREDENTIAL_UNBOUND from activation: the missing names. */
export const activationCredentialUnboundDetailsSchema = z
  .object({
    reason_code: z.literal("credential_unbound"),
    missing: z.array(credentialRefSchema).min(1),
  })
  .strict();

export type AgentContactView = z.infer<typeof agentContactSchema>;
export type SessionCredentialUnboundDetails = z.infer<
  typeof sessionCredentialUnboundDetailsSchema
>;
export type ActivationCredentialUnboundDetails = z.infer<
  typeof activationCredentialUnboundDetailsSchema
>;
