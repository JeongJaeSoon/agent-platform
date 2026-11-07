import { z } from "zod";

export const workspaceLimitModeSchema = z.object({
  bytes: z.enum(["hard", "soft", "unknown"]),
  inodes: z.enum(["hard", "soft", "unknown"]),
  reason: z.string().min(1).max(128),
});

export type WorkspaceLimitMode = z.infer<typeof workspaceLimitModeSchema>;
