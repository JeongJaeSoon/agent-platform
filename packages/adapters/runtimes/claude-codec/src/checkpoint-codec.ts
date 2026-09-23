/**
 * The Claude checkpoint manifest codec, in a package of its own so the control
 * plane can decode and validate manifests without depending on the Claude
 * Agent SDK: the API image is built without it (apps/api/Dockerfile), and the
 * adapter package that runs the SDK declares it. Everything that needs the
 * runtime's configuration (the profile fingerprint) stays in the adapter.
 */
import { createHash } from "node:crypto";
import type {
  CheckpointCodec,
  CheckpointManifest,
  CompatibilityMismatch,
  CompatibilityVerdict,
  RuntimeFingerprint,
} from "@agent-platform/runtime-core";
import { z } from "zod";

import { digestParts } from "./transcript-digest.ts";
import { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION } from "./versions.ts";

export const CLAUDE_CHECKPOINT_ENGINE = "claude";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
// Optional here, because whether versions are required is the deployment's
// call (CheckpointService `objectProtection`), not the manifest format's. S3
// ids are opaque UTF-8 of at most 1024 bytes; `"null"` is refused because it
// names the replaceable unversioned slot. Same rules as the wire contract's.
const objectVersionSchema = z
  .string()
  .min(1)
  .refine((version) => version !== "null", {
    message: 'version "null" is not an immutable version',
  })
  .refine((version) => new TextEncoder().encode(version).byteLength <= 1024, {
    message: "a version id is at most 1024 bytes of UTF-8",
  });
const objectRefSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    key: z.string().min(1),
    sha256: sha256Schema,
    version: objectVersionSchema.optional(),
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
// The label is the transcript's subpath under the session directory, and a
// restore plan hands it on as one; the same rule ClaudeSessionStore applies
// when it writes the file, so a manifest can never name a place the store
// would refuse.
const subagentLabelSchema = z
  .string()
  .min(1)
  .refine(
    (label) =>
      !label.includes("\\") &&
      label
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    { message: "subagent label must be a relative subpath free of . and .." },
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
        subagents: z.record(subagentLabelSchema, transcriptRevisionSchema),
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

export function encodeCheckpointManifest(manifest: CheckpointManifest): {
  bytes: Uint8Array;
  sha256: string;
} {
  // Canonical key order: the manifest's digest is its identity in the object
  // store, so the same manifest must serialize to the same bytes every time.
  const text = `${JSON.stringify(canonical(manifestSchema.parse(manifest)))}\n`;
  return { bytes: new TextEncoder().encode(text), sha256: sha256Hex(text) };
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
  // Zod types an optional field as `T | undefined`; parsing JSON can only
  // leave it out, which is what `CheckpointManifest` says.
  const manifest = result.data as CheckpointManifest;
  const edited = editedRevision(manifest);
  if (edited !== undefined) {
    throw new Error(`Invalid Claude checkpoint manifest: ${edited}`);
  }
  return manifest;
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

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
