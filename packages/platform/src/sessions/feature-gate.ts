import type { RuntimeConfig, RuntimeKind } from "@werft-ai/contracts";
import {
  type FeatureKey,
  type RuntimeDescriptor,
  runtimeRequirementsOf,
  unmetFeatures,
} from "@werft-ai/runtime-core";

export class UnsupportedRuntimeFeature extends Error {
  constructor(
    readonly at: "catalog_load" | "session_create",
    readonly kind: RuntimeKind,
    readonly missing: readonly FeatureKey[],
  ) {
    super(
      `Runtime ${kind} does not support ${missing.join(", ")} (${at.replace("_", " ")})`,
    );
    this.name = "UnsupportedRuntimeFeature";
  }
}

/**
 * Refuses a profile whose settings need a feature its runtime declares
 * `none`, before a session is created on it. The descriptors come from the
 * composition root: this package cannot import an adapter.
 */
export class ProfileFeatureGate {
  constructor(
    private readonly descriptors: Partial<
      Record<RuntimeKind, RuntimeDescriptor>
    >,
  ) {}

  /** A catalog profile alone: no release, so no MCP server yet. */
  atCatalogLoad(
    kind: RuntimeKind,
    profile: Pick<RuntimeConfig, "permission_mode">,
  ): void {
    this.check("catalog_load", kind, profile);
  }

  /** The claim's settings, with the release's MCP server folded in. */
  atSessionCreate(
    kind: RuntimeKind,
    runtimeConfig: Pick<RuntimeConfig, "mcp_servers" | "permission_mode">,
  ): void {
    this.check("session_create", kind, runtimeConfig);
  }

  private check(
    at: UnsupportedRuntimeFeature["at"],
    kind: RuntimeKind,
    runtimeConfig: Pick<RuntimeConfig, "mcp_servers" | "permission_mode">,
  ): void {
    const descriptor = this.descriptors[kind];
    if (descriptor === undefined) {
      throw new Error(`No runtime of kind ${kind} is installed`);
    }
    const missing = unmetFeatures(
      descriptor.capabilities,
      descriptor.extraFeatures,
      runtimeRequirementsOf(runtimeConfig),
    );
    if (missing.length > 0) {
      throw new UnsupportedRuntimeFeature(at, kind, missing);
    }
  }
}
