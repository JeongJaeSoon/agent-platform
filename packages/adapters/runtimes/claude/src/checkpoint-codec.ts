import { createHash } from "node:crypto";
import type {
  CheckpointCodec,
  CheckpointManifest,
  CompatibilityMismatch,
  CompatibilityVerdict,
  RuntimeFingerprint,
} from "@agent-platform/runtime-core";
import { z } from "zod";
import { describeComponents } from "./component-identity.ts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  type ClaudeRuntimeConfig,
} from "./config.ts";
import { publicProfile } from "./profile.ts";
import { digestParts } from "./transcript-digest.ts";

export const CLAUDE_CHECKPOINT_ENGINE = "claude";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const objectRefSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    key: z.string().min(1),
    sha256: sha256Schema,
  })
  .strict();
// Restoring writes these paths into a workspace, so the manifest is where
// traversal is refused — not the code that later unpacks it.
const workspaceArtifactSchema = objectRefSchema
  .extend({ path: z.string().min(1) })
  .strict()
  .refine(
    (artifact) =>
      !artifact.path.startsWith("/") &&
      !artifact.path.includes("\\") &&
      !artifact.path
        .split("/")
        .some((segment) => segment === ".." || segment === ""),
    { message: "workspace path must be relative and free of .. segments" },
  );
const transcriptRevisionSchema = z
  .object({
    entryCount: z.number().int().nonnegative(),
    parts: z.array(objectRefSchema).min(1),
    sha256: sha256Schema,
  })
  .strict();
const runtimeFingerprintSchema = z
  .object({
    cliVersion: z.string().min(1),
    engine: z.literal(CLAUDE_CHECKPOINT_ENGINE),
    profileSha256: sha256Schema,
    sdkVersion: z.string().min(1),
  })
  .strict();

// `.strict()` throughout: an unknown field means the manifest was written by a
// build this one does not understand, and guessing at it is how a restore ends
// up resuming something other than what was captured.
const manifestSchema = z
  .object({
    createdAt: z.iso.datetime(),
    cwd: z.string().startsWith("/"),
    engine: z.literal(CLAUDE_CHECKPOINT_ENGINE),
    resume: z.string().min(1),
    revision: z.number().int().nonnegative(),
    runtime: runtimeFingerprintSchema,
    sessionId: z.string().min(1),
    transcripts: z
      .object({
        root: transcriptRevisionSchema,
        subagents: z.record(z.string().min(1), transcriptRevisionSchema),
      })
      .strict(),
    version: z.literal(2),
    workspace: z
      .object({
        bundle: objectRefSchema,
        gitCommit: z.string().regex(/^[0-9a-f]{40}$/),
        untracked: z.array(workspaceArtifactSchema),
      })
      .strict(),
  })
  .strict();

export type ClaudeCheckpointManifest = z.infer<typeof manifestSchema>;

export const CLAUDE_RUNTIME_FINGERPRINT = {
  cliVersion: CLAUDE_CODE_VERSION,
  engine: CLAUDE_CHECKPOINT_ENGINE,
  sdkVersion: CLAUDE_AGENT_SDK_VERSION,
} as const;

/**
 * Digest of everything about a run's configuration that changes how a stored
 * transcript replays, plus who the run acts for. The model credential is
 * excluded — `publicProfile` drops it — so rotating a key does not invalidate
 * a checkpoint, while pointing the run at a different endpoint, tool
 * allowlist or owner partition does. The principal is what keeps two tenants
 * on one shared endpoint from producing the same digest and resuming each
 * other's sessions.
 *
 * MCP servers and plugins go through `describeComponents`: a serializable
 * server is hashed as its configuration with credential containers reduced to
 * key names, and anything the fingerprint cannot hash by value — an
 * in-process server, a plugin's contents — is hashed as the identity its
 * caller declared. A component without one throws
 * `UnidentifiedComponentError`; run validation calls this first so such a
 * config is refused before it starts rather than at its first checkpoint.
 */
export function claudeProfileFingerprint(
  config: Pick<
    ClaudeRuntimeConfig,
    | "appendSystemPrompt"
    | "identities"
    | "mcpServers"
    | "model"
    | "permissionMode"
    | "plugins"
    | "profile"
    | "settingSources"
    | "tools"
  >,
): string {
  const components = describeComponents(config);
  return sha256(
    JSON.stringify(
      canonical({
        appendSystemPrompt: config.appendSystemPrompt ?? null,
        mcpServers: components.mcpServers,
        model: config.model,
        permissionMode: config.permissionMode ?? "default",
        plugins: components.plugins,
        profile: publicProfile(config.profile),
        settingSources: config.settingSources ?? ["project"],
        tools: [...config.tools].sort(),
      }),
    ),
  );
}

export function encodeCheckpointManifest(manifest: CheckpointManifest): {
  bytes: Uint8Array;
  sha256: string;
} {
  // Canonical key order: the manifest's digest is its identity in the object
  // store, so the same manifest must serialize to the same bytes every time.
  const text = `${JSON.stringify(canonical(manifestSchema.parse(manifest)))}\n`;
  return { bytes: new TextEncoder().encode(text), sha256: sha256(text) };
}

export function decodeCheckpointManifest(
  bytes: Uint8Array,
): CheckpointManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(
      `Checkpoint manifest is not JSON: ${(error as Error).message}`,
    );
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid Claude checkpoint manifest: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
        .join("; ")}`,
    );
  }
  const edited = editedRevision(result.data);
  if (edited !== undefined) {
    throw new Error(`Invalid Claude checkpoint manifest: ${edited}`);
  }
  return result.data;
}

/**
 * A revision's digest covers its own part list, so a manifest that names a
 * different set of parts than the one that was captured is detectable from the
 * manifest alone. Catching it here is what keeps the pointer from advancing to
 * a checkpoint that only fails once someone tries to restore it.
 */
function editedRevision(manifest: CheckpointManifest): string | undefined {
  for (const [label, revision] of [
    ["root", manifest.transcripts.root] as const,
    ...Object.entries(manifest.transcripts.subagents),
  ]) {
    if (digestParts(revision.parts) !== revision.sha256) {
      return `transcript ${label} part list does not match its digest`;
    }
  }
  return undefined;
}

export function validateCompatibility(
  manifest: CheckpointManifest,
  runtime: RuntimeFingerprint,
): CompatibilityVerdict {
  const mismatches: CompatibilityMismatch[] = [];
  for (const field of [
    "engine",
    "sdkVersion",
    "cliVersion",
    "profileSha256",
  ] as const) {
    const expected = runtime[field];
    const found = manifest.runtime[field];
    if (expected !== found) mismatches.push({ expected, field, found });
  }
  return mismatches.length === 0
    ? { status: "compatible" }
    : { mismatches, status: "incompatible" };
}

export const claudeCheckpointCodec: CheckpointCodec = {
  decode: decodeCheckpointManifest,
  encode: encodeCheckpointManifest,
  engine: CLAUDE_CHECKPOINT_ENGINE,
  validateCompatibility,
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
