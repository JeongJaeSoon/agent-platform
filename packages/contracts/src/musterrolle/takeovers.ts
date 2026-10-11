import { z } from "zod";

import { receiptAcceptedResponseSchema } from "../api/receipt.ts";
import { sessionStatusSchema } from "../api/session.ts";
import {
  sessionIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";

/**
 * A session whose requester was offboarded (design D16). It takes no input
 * until an owner takes it over and becomes its requester.
 */
export const takeoverSchema = z
  .object({
    session_id: sessionIdSchema,
    /** The offboarded person who asked for the session. */
    departed_user_id: userIdSchema,
    status: sessionStatusSchema,
    created_at: timestampSchema,
    takeover_required_at: timestampSchema,
  })
  .strict();

export const TAKEOVER_LIST_LIMIT = 200;

export const listTakeoversResponseSchema = z
  .object({ items: z.array(takeoverSchema).max(TAKEOVER_LIST_LIMIT) })
  .strict();

export const takeOverSessionResponseSchema = receiptAcceptedResponseSchema;

export type Takeover = z.infer<typeof takeoverSchema>;
export type ListTakeoversResponse = z.infer<typeof listTakeoversResponseSchema>;
export type TakeOverSessionResponse = z.infer<
  typeof takeOverSessionResponseSchema
>;
