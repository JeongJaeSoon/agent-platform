import type {
  BindingMode,
  MemoryWritePolicy,
  SurfaceBindingStatus,
  SurfaceCeiling,
  SurfaceChannelKind,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";

export type SurfaceBindingRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  installationId: string | null;
  /** The Slack channel id; null on the install's DM binding. */
  channelId: string | null;
  channelKind: SurfaceChannelKind | null;
  mode: BindingMode;
  ceiling: SurfaceCeiling;
  home: boolean;
  memoryWritePolicy: MemoryWritePolicy;
  status: SurfaceBindingStatus;
  muted: boolean;
  revision: number;
  createdAt: Date;
  revokedAt: Date | null;
};

export type SetSurfaceBindingResult =
  | { outcome: "set"; binding: SurfaceBindingRecord; receiptId: string }
  | { outcome: "agent_not_found" }
  // The agent has no live identity, so no install to bind a channel of.
  | { outcome: "not_installed" }
  // A concurrent write took the channel, the DM row or the home first.
  | { outcome: "conflict" }
  | { outcome: "actor_inactive" }
  | { outcome: "outranked" };

export interface SurfaceBindingStore {
  /**
   * Replaces the live binding of one channel of the agent's install, or its
   * DM binding when `channelId` is null, and moves the agent's home here
   * when `home` is set. Re-reads the caller's right in the same transaction
   * and writes a `set_surface_binding` receipt.
   */
  set(input: {
    principal: Principal;
    workspaceId: string;
    agentId: string;
    channelId: string | null;
    channelKind: SurfaceChannelKind;
    mode: BindingMode;
    home: boolean;
    ceiling: SurfaceCeiling;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<SetSurfaceBindingResult>;
  /** The agent's live bindings, home first, then oldest first. */
  list(
    workspaceId: string,
    agentId: string,
    limit: number,
  ): Promise<SurfaceBindingRecord[]>;
  /**
   * The live binding of a channel of an install, or of its DMs when
   * `channelId` is null. Read for every event; never cached.
   */
  resolveSlackChannel(
    installationId: string,
    channelId: string | null,
  ): Promise<SurfaceBindingRecord | null>;
  /**
   * The install's DM binding, made on its first DM when it has none
   * (`mention`, the default ceiling, no receipt: no person set it). Two
   * first DMs at once make one row. Null when the install has no live agent
   * identity or its DM row is not ready.
   */
  ensureDmBinding(installationId: string): Promise<SurfaceBindingRecord | null>;
}
