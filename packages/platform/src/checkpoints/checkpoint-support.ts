import { createHash } from "node:crypto";
import type { CheckpointManifest } from "@agent-platform/runtime-core";

import {
  CHECKPOINT_ROOT_PARENT,
  type CheckpointPointer,
} from "../ports/checkpoint-store.ts";

/**
 * The revision a checkpoint's state was built on. Rows from before the
 * parent was recorded (94S-204) come from a history with no fallback in it,
 * where that is always the revision before.
 */
export function parentOf(checkpoint: CheckpointPointer): number | null {
  if (checkpoint.parentRevision === CHECKPOINT_ROOT_PARENT) return null;
  if (checkpoint.parentRevision != null) return checkpoint.parentRevision;
  return checkpoint.revision > 0 ? checkpoint.revision - 1 : null;
}

/**
 * Reads only the engine discriminator, to pick the codec that validates the
 * rest. The platform never interprets a manifest body itself.
 */
export function engineOf(bytes: Uint8Array): string | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const engine = (parsed as { engine?: unknown }).engine;
    return typeof engine === "string" ? engine : undefined;
  } catch {
    return undefined;
  }
}

/** Maps `items` in fixed-size waves, keeping the results in input order. */
export async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(
      ...(await Promise.all(items.slice(start, start + size).map(map))),
    );
  }
  return results;
}

// Codec registries are plain objects; inherited keys are not codecs.
export function own<T>(record: Readonly<Record<string, T>>, key: string) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Versions to keep, and keys whose every version is kept. Only a row a locked
 * finalize committed (`versionsHeld`) vouches for the versions it names. Any
 * other named whatever the worker reported, which a restore re-reads by key
 * and re-holds, so every version of those keys stays.
 */
export function keepSet() {
  const keys = new Set<string>();
  const versions = new Set<string>();
  const add = (key: string, version: string | undefined) => {
    if (version === undefined) keys.add(key);
    else versions.add(JSON.stringify([key, version]));
  };
  return {
    /** The committed checkpoint's manifest and every object it names. */
    addManifest(
      checkpoint: CheckpointPointer,
      manifest: CheckpointManifest,
    ): void {
      const trusted = checkpoint.versionsHeld === true;
      add(
        checkpoint.manifestRef,
        trusted ? (checkpoint.manifestVersion ?? undefined) : undefined,
      );
      for (const ref of [
        ...manifest.transcripts.root.parts,
        ...Object.values(manifest.transcripts.subagents).flatMap(
          (revision) => revision.parts,
        ),
        manifest.workspace.bundle,
        ...manifest.workspace.untracked,
      ]) {
        add(ref.key, trusted ? ref.version : undefined);
      }
    },
    has(entry: { key: string; version?: string | undefined }): boolean {
      return (
        keys.has(entry.key) ||
        (entry.version !== undefined &&
          versions.has(JSON.stringify([entry.key, entry.version])))
      );
    },
  };
}
