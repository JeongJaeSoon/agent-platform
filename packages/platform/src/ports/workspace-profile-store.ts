import type { RepositoryMode } from "@werft-ai/contracts";
import type {
  ProfileNarrowing,
  WorkspaceProfileRecord,
} from "../sessions/catalog.ts";
import type { TeamActor } from "./team-store.ts";

type Write = { actor: TeamActor; receiptId: string };

/**
 * `version_taken`: another write made the same version first; asking again
 * makes the next one.
 */
export type CreateWorkspaceProfileResult =
  | { outcome: "created"; record: WorkspaceProfileRecord }
  | { outcome: "actor_inactive" | "version_taken" };

/** `unchanged`: it was already retired; no receipt. */
export type RetireWorkspaceProfileResult =
  | { outcome: "retired" | "unchanged"; record: WorkspaceProfileRecord }
  | { outcome: "not_found" | "actor_inactive" };

export interface WorkspaceProfileStore {
  /** Every version of every workspace: what a process resolves ids against. */
  listAll(): Promise<WorkspaceProfileRecord[]>;
  /**
   * The next version of `name` in the actor's workspace, its id
   * `ws_<workspace slug>_<name>_v<n>`. The actor must still be a live owner
   * or admin.
   */
  create(
    input: Write & {
      name: string;
      baseProfileId: string;
      base: {
        fingerprint: string;
        runtimeVersion: string;
        billing: "metered" | "none";
        repositoryMode: RepositoryMode;
      };
      narrowing: ProfileNarrowing;
    },
  ): Promise<CreateWorkspaceProfileResult>;
  retire(
    input: Write & { profileId: string },
  ): Promise<RetireWorkspaceProfileResult>;
}
