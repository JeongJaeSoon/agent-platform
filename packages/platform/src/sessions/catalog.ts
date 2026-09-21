import { runtimeKindSchema } from "@agent-platform/contracts";
import { z } from "zod";

// Operator-registered profile/repository allowlist. Loaded from config until
// 94S-132 adds a registration API.
export const sessionCatalogSchema = z
  .object({
    profiles: z.record(
      z.string().min(1),
      z.object({
        runtime_kind: runtimeKindSchema,
        runtime_version: z.string().min(1),
      }),
    ),
    repositories: z.record(
      z.string().min(1),
      z.object({ url: z.string().min(1), branch: z.string().min(1) }),
    ),
  })
  .strict();

export type SessionCatalog = z.infer<typeof sessionCatalogSchema>;

export function parseSessionCatalog(json: string | undefined): SessionCatalog {
  return sessionCatalogSchema.parse(
    JSON.parse(json ?? '{"profiles":{},"repositories":{}}'),
  );
}
