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

// Names the env var in the failure so an operator can tell which setting is
// wrong without reading a stack trace.
export function parseSessionCatalogEnv(
  name: string,
  value: string | undefined,
): SessionCatalog {
  try {
    return parseSessionCatalog(value);
  } catch (error) {
    const detail =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`${name} is invalid: ${detail}`, { cause: error });
  }
}

export function isCatalogEmpty(catalog: SessionCatalog): boolean {
  return (
    Object.keys(catalog.profiles).length === 0 ||
    Object.keys(catalog.repositories).length === 0
  );
}
