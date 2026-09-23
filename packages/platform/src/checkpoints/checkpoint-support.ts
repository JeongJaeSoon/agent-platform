import { createHash } from "node:crypto";

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
