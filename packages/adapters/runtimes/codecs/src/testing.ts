import { digestParts } from "@werft-ai/runtime-claude-codec";
import type { ObjectRef } from "@werft-ai/runtime-core";

const transcriptDigests = new Map<
  string,
  (parts: readonly ObjectRef[]) => string
>([["claude", digestParts]]);

/** How the codec of `engine` digests a transcript revision's parts, for fixtures that build one. */
export function transcriptDigestFor(
  engine: string,
): (parts: readonly ObjectRef[]) => string {
  const digest = transcriptDigests.get(engine);
  if (digest === undefined) {
    throw new Error(`No checkpoint codec is installed for ${engine}`);
  }
  return digest;
}
