import { createHash } from "node:crypto";
import type { ObjectRef } from "@agent-platform/runtime-core";

/**
 * The digest that pins a transcript revision's part list.
 *
 * Both sides of a checkpoint depend on this being one rule: the mirror computes
 * it when it captures a revision, and the codec recomputes it when it decodes a
 * manifest, so a manifest whose part list was edited after capture is refused
 * before it can become the session's restore point. Fields are rewritten in a
 * fixed order rather than serialized as they arrive, because the digest must
 * not depend on how the object was built.
 */
export function digestParts(parts: readonly ObjectRef[]): string {
  const canonical = parts.map((part) => ({
    bytes: part.bytes,
    key: part.key,
    sha256: part.sha256,
  }));
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}
