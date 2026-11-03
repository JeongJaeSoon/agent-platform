import { z } from "zod";

/**
 * The installation's settings without a secret value
 * (docs/contributing/decisions/settings-replace-file-catalog.md §6). Each
 * entry is checked on import against the catalog's own rules; this schema
 * holds only the document's outline.
 */
export const settingsDocumentSchema = z
  .object({
    version: z.literal(1),
    connections: z.record(z.string().min(1), z.record(z.string(), z.unknown())),
    repositories: z.record(
      z.string().min(1),
      z.record(z.string(), z.unknown()),
    ),
    mcp_servers: z.record(z.string().min(1), z.record(z.string(), z.unknown())),
  })
  .strict();
export type SettingsDocumentBody = z.infer<typeof settingsDocumentSchema>;

export const exportSettingsResponseSchema = z
  .object({
    document: settingsDocumentSchema,
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
export type ExportSettingsResponse = z.infer<
  typeof exportSettingsResponseSchema
>;

export const importSettingsQuerySchema = z
  .object({ dry_run: z.enum(["true", "false"]).optional() })
  .strict();

/** Entries as `<kind>:<id>` (`connection:`, `repository:`, `mcp:`). */
const entryList = z.array(z.string().min(1));

export const importSettingsResponseSchema = z
  .object({
    outcome: z.enum(["applied", "dry_run"]),
    added: entryList,
    unchanged: entryList,
    /** Same content as a disabled or removed row, which stays so. */
    inactive: entryList,
    /** Stored entries that run once the console sets their value. */
    needs_value: entryList,
    receipt_ids: z.array(z.string().uuid()),
  })
  .strict();
export type ImportSettingsResponse = z.infer<
  typeof importSettingsResponseSchema
>;
