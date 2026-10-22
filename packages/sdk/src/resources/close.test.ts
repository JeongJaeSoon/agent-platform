import { describe, expect, test } from "bun:test";
import {
  CLOSE_BLOCKED,
  type CloseReceiptResult,
  closeBlocked,
  closeResult,
  isApiError,
  isClosing,
  type Receipt,
  SESSION_ADMISSION_CLOSING,
  SESSION_CLOSING,
  type Session,
} from "../index.ts";
import { apiError, fakeApi, json, werft } from "../testing/fake-api.ts";

const ACCEPTED = { receipt_id: "r1", receipt_status: "accepted" };

describe("sessions.close", () => {
  test("POSTs { expected_revision, reason } to /close with an Idempotency-Key and returns the receipt", async () => {
    const api = fakeApi(() => json(202, ACCEPTED));
    const accepted = await werft(api.fetch).sessions.close("s1", {
      expected_revision: 7,
      reason: "Work is done",
    });
    expect(accepted).toEqual(ACCEPTED);
    const [request] = api.seen;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/v1/sessions/s1/close");
    expect(request?.body).toEqual({
      expected_revision: 7,
      reason: "Work is done",
    });
    expect(request?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a retried close sends the same key", async () => {
    let calls = 0;
    const api = fakeApi(() =>
      ++calls === 1
        ? apiError(
            503,
            "BACKEND_UNAVAILABLE",
            {
              retryable: true,
            },
            { "retry-after": "0" },
          )
        : json(202, ACCEPTED),
    );
    await werft(api.fetch).sessions.close("s1", { expected_revision: 1 });
    const keys = api.seen.map((r) => r.headers.get("idempotency-key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1] ?? "");
  });

  test("SESSION_CLOSING arrives as the server's code and is not retried", async () => {
    const api = fakeApi(() => apiError(409, SESSION_CLOSING));
    const error = await werft(api.fetch)
      .sessions.messages.send("s1", { message: "one more" })
      .catch((e: unknown) => e);
    expect(isApiError(error, SESSION_CLOSING)).toBe(true);
    expect(api.seen).toHaveLength(1);
  });
});

describe("close values", () => {
  test("closing admission and CLOSE_BLOCKED attention read as typed values", () => {
    const draining = {
      admission_state: "closing",
      attention: { code: "CLOSE_BLOCKED", reason: "pending_request" },
    } as Pick<Session, "admission_state" | "attention">;
    expect(SESSION_ADMISSION_CLOSING).toBe("closing");
    expect(isClosing(draining)).toBe(true);
    expect(closeBlocked(draining)).toEqual({
      code: CLOSE_BLOCKED,
      reason: "pending_request",
    });
    const paused = {
      admission_state: "paused",
      attention: { code: "PAUSE_BLOCKED", reason: "long_turn" },
    } as Pick<Session, "admission_state" | "attention">;
    expect(isClosing(paused)).toBe(false);
    expect(closeBlocked(paused)).toBeNull();
  });

  test("closeResult types a succeeded close receipt's result and nothing else", () => {
    const result: CloseReceiptResult = {
      resulting_admission_state: "closed",
      checkpoint_revision: 3,
      cancelled_turn_count: 1,
    };
    const receipt = (fields: Partial<Receipt>) =>
      ({
        operation: "close",
        status: "succeeded",
        result,
        ...fields,
      }) as Receipt;
    expect(closeResult(receipt({}))).toEqual(result);
    expect(
      closeResult(receipt({ result: { ...result, checkpoint_revision: null } }))
        ?.checkpoint_revision,
    ).toBeNull();
    expect(closeResult(receipt({ status: "accepted" }))).toBeNull();
    expect(closeResult(receipt({ operation: "pause" }))).toBeNull();
    expect(
      closeResult(receipt({ result: { queued_turn_count: 1 } })),
    ).toBeNull();
  });
});
