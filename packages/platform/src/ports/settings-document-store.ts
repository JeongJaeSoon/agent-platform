import type {
  SettingsEntries,
  SettingsImportPlan,
} from "../sessions/settings-document.ts";
import type { TeamActor } from "./team-store.ts";

export type SettingsImportResult =
  | (SettingsImportPlan & {
      /**
       * `refused`: a conflict or a refused reference, and nothing written.
       * `dry_run`: what `applied` would have written.
       */
      outcome: "applied" | "dry_run" | "refused";
      /** One per added row; empty when no workspace exists to keep them under. */
      receipt_ids: string[];
    })
  | { outcome: "actor_inactive" };

export interface SettingsDocumentStore {
  /**
   * The rows not disabled or removed, as entries, and each stored value's
   * last four characters by its reference; no value is opened.
   */
  exportEntries(): Promise<{
    entries: SettingsEntries;
    last4: ReadonlyMap<string, string>;
  }>;
  /**
   * Adds the entries whose id no row holds, in one transaction under the
   * settings writers' locks, or nothing when the plan has a conflict or a
   * refused reference. `actor` null is the operator's CLI: no one to check
   * and a system receipt; otherwise the actor must still be a live owner.
   */
  importEntries(
    entries: SettingsEntries,
    options: {
      dryRun: boolean;
      allowExternal: boolean;
      actor: TeamActor | null;
    },
  ): Promise<SettingsImportResult>;
}
