import { z } from "zod/v4";

export const healthResponseSchema = z.object({ status: z.literal("ok") });
export const readyResponseSchema = z.object({ status: z.literal("ready") });
export const apiRootResponseSchema = z
  .object({
    status: z.literal("ok"),
    owner_id: z.string().min(1),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
export type ApiRootResponse = z.infer<typeof apiRootResponseSchema>;
