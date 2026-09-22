import { createHash } from "node:crypto";
import type {
  CheckpointCodec,
  CheckpointManifest,
  CompatibilityMismatch,
  CompatibilityVerdict,
  RuntimeFingerprint,
} from "@agent-platform/runtime-core";
import { z } from "zod";

import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  type ClaudeRuntimeConfig,
} from "./config.ts";
import { publicProfile } from "./profile.ts";

export const CLAUDE_CHECKPOINT_ENGINE = "claude";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const objectRefSchema = z
  .object({ key: z.string().min(1), sha256: sha256Schema })
  .strict();
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
    version: z.literal(1),
    workspace: z
      .object({
        gitCommit: z.string().regex(/^[0-9a-f]{40}$/),
        untracked: z.array(objectRefSchema),
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
 * transcript replays. Credentials are excluded — `publicProfile` drops them —
 * so rotating a key does not invalidate a checkpoint, while pointing the run at
 * a different endpoint or tool allowlist does.
 */
export function claudeProfileFingerprint(
  config: Pick<
    ClaudeRuntimeConfig,
    | "appendSystemPrompt"
    | "mcpServers"
    | "model"
    | "permissionMode"
    | "plugins"
    | "profile"
    | "settingSources"
    | "tools"
  >,
): string {
  return sha256(
    JSON.stringify(
      canonical({
        appendSystemPrompt: config.appendSystemPrompt ?? null,
        mcpServers: Object.keys(config.mcpServers ?? {}).sort(),
        model: config.model,
        permissionMode: config.permissionMode ?? "default",
        plugins: (config.plugins ?? []).map((plugin) => plugin.path).sort(),
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
  return result.data;
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
