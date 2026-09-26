import { describe, expect, test } from "bun:test";
import { createInterruptService } from "../sessions/interrupt-service.ts";
import { createPendingRequestService } from "../sessions/pending-service.ts";
import {
  createSessionService,
  SessionServiceError,
} from "../sessions/session-service.ts";
import { createUsageService } from "../usage/usage-service.ts";
import type { AuthorizationPolicy, SessionAction } from "./policy.ts";

// Any store call means the refusal came too late.
const unreachable = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("the store must not be reached");
    },
  },
) as never;

function refusing(action: SessionAction): AuthorizationPolicy {
  return { authorize: (_actor, asked) => asked !== action };
}

function services(authorization: AuthorizationPolicy) {
  const sessions = createSessionService({
    authorization,
    inputs: unreachable,
    controls: unreachable,
    reader: unreachable,
    catalog: unreachable,
    limits: unreachable,
  });
  const pending = createPendingRequestService({
    authorization,
    store: unreachable,
  });
  const interrupts = createInterruptService({
    authorization,
    store: unreachable,
  });
  const usage = createUsageService({
    authorization,
    reader: unreachable,
    limits: unreachable,
  });
  return { sessions, pending, interrupts, usage };
}

type Services = ReturnType<typeof services>;
const actor = { ownerId: "owner-a" };
const id = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const input = unreachable;

// Every service entry point with the action it needs. A policy that takes an
// action away refuses each of them, whichever service owns it (94S-397).
const entryPoints: [
  string,
  SessionAction,
  (s: Services) => Promise<unknown>,
][] = [
  [
    "createSession",
    "sessions:write",
    (s) => s.sessions.createSession(actor, input),
  ],
  [
    "appendMessage",
    "sessions:write",
    (s) => s.sessions.appendMessage(actor, id, input),
  ],
  [
    "terminateSession",
    "sessions:control",
    (s) => s.sessions.terminateSession(actor, id, input),
  ],
  [
    "pauseSession",
    "sessions:control",
    (s) => s.sessions.pauseSession(actor, id, input),
  ],
  [
    "resumeSession",
    "sessions:control",
    (s) => s.sessions.resumeSession(actor, id, input),
  ],
  [
    "decideRecovery",
    "sessions:recover",
    (s) => s.sessions.decideRecovery(actor, id, input),
  ],
  [
    "listSessions",
    "sessions:read",
    (s) => s.sessions.listSessions(actor, input),
  ],
  ["getSession", "sessions:read", (s) => s.sessions.getSession(actor, id)],
  ["listTurns", "sessions:read", (s) => s.sessions.listTurns(actor, id, input)],
  ["getTurn", "sessions:read", (s) => s.sessions.getTurn(actor, id, "1")],
  [
    "readEvents",
    "sessions:read",
    (s) => s.sessions.readEvents(actor, id, input),
  ],
  ["getReceipt", "sessions:read", (s) => s.sessions.getReceipt(actor, id)],
  [
    "listPendingRequests",
    "sessions:read",
    (s) => s.pending.listPendingRequests(actor, id),
  ],
  ["answer", "sessions:approve", (s) => s.pending.answer(actor, id, input)],
  [
    "interrupt",
    "sessions:control",
    (s) => s.interrupts.interrupt(actor, id, input),
  ],
  [
    "getSessionUsage",
    "sessions:read",
    (s) => s.usage.getSessionUsage(actor, id),
  ],
];

describe("AuthorizationPolicy", () => {
  for (const [name, action, call] of entryPoints) {
    test(`${name} is 403 FORBIDDEN before any store call when ${action} is refused`, async () => {
      const error = await call(services(refusing(action))).catch((e) => e);
      expect(error).toBeInstanceOf(SessionServiceError);
      expect(error).toMatchObject({ code: "FORBIDDEN" });
    });
  }

  test("is asked about the action alone, never the owner", async () => {
    const asked: unknown[][] = [];
    const recording: AuthorizationPolicy = {
      authorize: (...args) => {
        asked.push(args);
        return false;
      },
    };
    for (const [, , call] of entryPoints) {
      await call(services(recording)).catch(() => {});
    }
    expect(asked.map(([, action]) => action)).toEqual(
      entryPoints.map(([, action]) => action),
    );
    expect(asked.every((args) => args.length === 2)).toBe(true);
  });
});
