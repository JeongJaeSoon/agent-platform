import {
  type RuntimeKind,
  type SessionEventPayload,
  sessionEventPayloadSchema,
} from "@werft-ai/contracts";
import type { EventCodec } from "@werft-ai/runtime-core";

import {
  type CatalogProfileView,
  catalogProfile,
  type ProfileLookup,
} from "./catalog.ts";

/**
 * One stored or incoming event with the engine-neutral fields added by the
 * codec of its session's runtime, which the session's profile names. An
 * event whose runtime cannot be told (no profile, a profile the catalog no
 * longer holds, a kind with no codec installed) comes back as it was.
 */
export type NeutralizeEvent = (
  profileId: string | null,
  event: SessionEventPayload,
) => SessionEventPayload;

export function createNeutralizer(
  codecs: readonly EventCodec[],
  catalog: ProfileLookup<CatalogProfileView>,
  onUnknown: (profileId: string | null) => void = () => {},
): NeutralizeEvent {
  const byKind = new Map<RuntimeKind, EventCodec>(
    codecs.map((codec) => [codec.kind, codec]),
  );
  return (profileId, event) => {
    const kind =
      profileId === null
        ? undefined
        : catalogProfile(catalog, profileId)?.runtime_kind;
    const codec = kind === undefined ? undefined : byKind.get(kind);
    if (codec === undefined) {
      onUnknown(profileId);
      return event;
    }
    const out = codec.withNeutralFields(event);
    // Stored, a field the contract refuses would leave the event unreadable.
    return out === event || sessionEventPayloadSchema.safeParse(out).success
      ? out
      : event;
  };
}
