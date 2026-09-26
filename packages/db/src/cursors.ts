// Every public page cursor is minted and checked here. Anything a decoder
// does not recognise is InvalidCursorError, which the routes answer with 400.
import { sessionIdSchema } from "@agent-platform/contracts";
import { InvalidCursorError } from "@agent-platform/platform";
import { SEQUENCE_MAX } from "./control-shared.ts";

// The public SSE `id:` and the worker's append cursor are the same value: the
// events row id in base36 behind an `ev_` prefix. Opaque to clients, but
// stable across the worker protocol and the public stream so a client that
// saw the gateway's cursor can resume the stream from it.
const EVENT_CURSOR = /^ev_[0-9a-z]{1,11}$/;

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

function encodeJsonCursor(cursor: object): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeJsonCursor<T>(
  value: string,
  accept: (parsed: Record<string, unknown>) => T | undefined,
): T {
  try {
    const cursor = accept(
      JSON.parse(Buffer.from(value, "base64url").toString()),
    );
    if (cursor !== undefined) return cursor;
  } catch {}
  throw new InvalidCursorError();
}

// created_at is the database's own text rendering so microsecond precision
// survives the round trip (JS Date would truncate to milliseconds).
export type SessionCursor = { created_at: string; id: string };
// Only the exact shape PostgreSQL renders; JS Date.parse is far more lenient
// than the timestamptz cast and a forged cursor must not reach the query.
const PG_TIMESTAMPTZ_TEXT =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export function encodeSessionCursor(cursor: SessionCursor): string {
  return encodeJsonCursor(cursor);
}

export function decodeSessionCursor(value: string): SessionCursor {
  return decodeJsonCursor(value, (parsed) =>
    typeof parsed.created_at === "string" &&
    PG_TIMESTAMPTZ_TEXT.test(parsed.created_at) &&
    sessionIdSchema.safeParse(parsed.id).success
      ? (parsed as SessionCursor)
      : undefined,
  );
}

// Turns page in FIFO order; the cursor is the last sequence on the page.
export type TurnCursor = { sequence: number };

export function encodeTurnCursor(cursor: TurnCursor): string {
  return encodeJsonCursor(cursor);
}

export function decodeTurnCursor(value: string): TurnCursor {
  return decodeJsonCursor(value, (parsed) =>
    typeof parsed.sequence === "number" &&
    Number.isInteger(parsed.sequence) &&
    parsed.sequence >= 1 &&
    parsed.sequence <= SEQUENCE_MAX
      ? { sequence: parsed.sequence }
      : undefined,
  );
}
