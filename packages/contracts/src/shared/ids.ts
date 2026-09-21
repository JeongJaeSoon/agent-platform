import { z } from "zod";

export const sessionIdSchema = z.uuid();
export const turnIdSchema = z.string().min(1);
export const attemptIdSchema = z.string().min(1);
export const executionIdSchema = z.string().min(1);
export const receiptIdSchema = z.uuid();
export const requestIdSchema = z.string().min(1);
export const timestampSchema = z.iso.datetime();
export const revisionSchema = z.number().int().nonnegative();
export const epochSchema = z.number().int().nonnegative();
export const opaqueCursorSchema = z.string().min(1);
export const idempotencyKeySchema = z.string().min(1).max(255);
// `unknown` accepts undefined; use this where the key must be present.
export const requiredUnknownSchema = z
  .unknown()
  .refine((value) => value !== undefined, "Required");

export const sessionIdParamsSchema = z.object({ id: sessionIdSchema });
export const turnIdParamsSchema = sessionIdParamsSchema.extend({
  turn_id: turnIdSchema,
});
export const receiptIdParamsSchema = z.object({ id: receiptIdSchema });
export const idempotencyKeyHeadersSchema = z.object({
  "idempotency-key": idempotencyKeySchema,
});
export const lastEventIdHeadersSchema = z.object({
  "last-event-id": opaqueCursorSchema.optional(),
});

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;
export const paginationQuerySchema = z.object({
  cursor: opaqueCursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: opaqueCursorSchema.nullable(),
  });
}

export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;
export type TurnIdParams = z.infer<typeof turnIdParamsSchema>;
export type ReceiptIdParams = z.infer<typeof receiptIdParamsSchema>;
export type IdempotencyKeyHeaders = z.infer<typeof idempotencyKeyHeadersSchema>;
export type LastEventIdHeaders = z.infer<typeof lastEventIdHeadersSchema>;
export type OpaqueCursor = z.infer<typeof opaqueCursorSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
