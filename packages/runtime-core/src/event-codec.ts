import type { RuntimeKind, SessionEventPayload } from "@werft-ai/contracts";

/**
 * Reads the public events a runtime's adapter wrote and adds the
 * engine-neutral fields beside their v1 payload. The control plane runs it
 * on every event it stores, so what an older worker sent gets them too.
 */
export interface EventCodec {
  readonly kind: RuntimeKind;
  /**
   * The event with the neutral fields it lacks added; fields already there
   * are kept, and the v1 fields are never changed.
   */
  withNeutralFields(event: SessionEventPayload): SessionEventPayload;
}
