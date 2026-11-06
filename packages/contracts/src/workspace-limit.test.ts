import { expect, test } from "bun:test";
import {
  readStoredEvent,
  sessionDetailSchema,
  workspaceLimitModeSchema,
} from "./index.ts";

test("classification is optional for older workers and servers", () => {
  const field = sessionDetailSchema.shape.workspace_limit_mode;
  expect(field.parse(undefined)).toBeUndefined();
  expect(
    field.parse({
      bytes: "hard",
      inodes: "unknown",
      reason: "storage_declaration_and_capacity",
    }),
  ).toEqual({
    bytes: "hard",
    inodes: "unknown",
    reason: "storage_declaration_and_capacity",
  });
  expect(
    field.safeParse({ bytes: "enforced", inodes: "soft", reason: "bad" })
      .success,
  ).toBe(false);
});

test("older clients discard the optional field and still read the existing system event", () => {
  const oldDetail = sessionDetailSchema.omit({ workspace_limit_mode: true });
  const mode = workspaceLimitModeSchema.parse({
    bytes: "soft",
    inodes: "soft",
    reason: "shared_or_unaccounted_filesystem",
  });
  const at = "2026-11-06T00:00:00Z";
  const detail = {
    id: "019a0000-0000-7000-8000-000000000102",
    revision: 1,
    admission_state: "active",
    status: "idle",
    runtime: null,
    model: null,
    repository_id: null,
    current_turn_id: null,
    queued_turn_count: 0,
    last_event_at: null,
    created_at: at,
    updated_at: at,
    execution: null,
    checkpoint_revision: null,
    pending_request_count: 0,
    attention: null,
    durability: {
      last_transcript_persisted_at: null,
      checkpoint_committed_at: null,
      checkpoint_revision: null,
      last_completed_turn_id: null,
      last_checkpointed_turn_id: null,
      checkpoint_pending_reason: null,
      checkpoint_fallback_revision: null,
      context_reset_turn_id: null,
    },
  };
  expect(sessionDetailSchema.parse(detail)).not.toHaveProperty(
    "workspace_limit_mode",
  );
  expect(oldDetail.parse({ ...detail, workspace_limit_mode: mode })).toEqual(
    oldDetail.parse(detail),
  );
  expect(
    readStoredEvent("system", {
      type: "system",
      subtype: "workspace_limit_mode",
      ...mode,
    }),
  ).toMatchObject({
    readable: true,
    payload: { event: "system", data: { ...mode } },
  });
});
