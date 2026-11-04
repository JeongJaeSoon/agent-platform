import type {
  SettingsEntries,
  SettingsImportAdd,
  SettingsImportPlan,
  SettingsKind,
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
      /** An import of an old catalog directory: see `SettingsImportPlan.kept`. */
      databaseOwnsAppRepositories?: boolean;
      actor: TeamActor | null;
    },
  ): Promise<SettingsImportResult>;

  /**
   * Every row of one kind, disabled and removed ones too; for repositories
   * only those that are not the console App's.
   */
  listRows(kind: SettingsKind): Promise<SettingsRow[]>;

  /**
   * The console's writes, each in one transaction under the import's locks
   * and with one receipt. `create` plans the entry as an import would, so
   * an id ever taken, or a value already sealed under it, is refused; the
   * row's own value is sealed in the same transaction.
   */
  create(
    add: SettingsImportAdd,
    value: string | null,
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  setValue(
    owner: { kind: SettingsKind; id: string },
    value: string,
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  /** For a repository: removed. Never undone; the id stays taken. */
  disable(
    owner: { kind: SettingsKind; id: string },
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  setMcpWorkspaces(
    id: string,
    workspaces: readonly string[],
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  /** A new version of the row with another default branch. */
  setRepositoryBranch(
    id: string,
    branch: string,
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
}

export type SettingsRow = {
  id: string;
  /** The row as an entry would be, `stored` naming its own reference. */
  entry: unknown;
  origin: "import" | "console";
  /** A stored value's last four characters; null when none is set. */
  last4: string | null;
  createdAt: Date;
  /** Disabled, or for a repository removed. */
  disabledAt: Date | null;
};

export type SettingsConsoleResult =
  | { outcome: "done"; receiptId: string }
  /** The actor lost the role the write needs after the policy's check. */
  | { outcome: "actor_inactive" }
  | { outcome: "not_found" }
  | {
      outcome: "conflict";
      /**
       * `already_exists`: the id, or a value sealed under it, is taken.
       * `not_stored`: the row's credential is not its own value (an
       * operator's reference, which the console only shows and disables).
       * `disabled`: the row is disabled or removed.
       */
      reason: "already_exists" | "not_stored" | "disabled";
    };
