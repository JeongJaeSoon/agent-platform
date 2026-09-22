// The public SSE `id:` and the worker's append cursor are the same value: the
// events row id in base36 behind an `ev_` prefix. Opaque to clients, but
// stable across the worker protocol and the public stream so a client that
// saw the gateway's cursor can resume the stream from it.
const EVENT_CURSOR = /^ev_[0-9a-z]{1,11}$/;

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
  }
}

export function encodeEventCursor(id: number): string {
  return `ev_${id.toString(36)}`;
}

// 0 means "from the beginning"; there is no row 0, so `> 0` reads everything.
export function decodeEventCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!EVENT_CURSOR.test(cursor)) throw new InvalidCursorError();
  const id = Number.parseInt(cursor.slice(3), 36);
  if (!Number.isSafeInteger(id) || id < 0) throw new InvalidCursorError();
  return id;
}
