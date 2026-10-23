import { z } from "zod";

import {
  surfaceBindingSchema,
  surfaceCeilingSchema,
  surfaceChannelKindSchema,
} from "../kollegium/surfaces.ts";
import { receiptIdSchema } from "../shared/index.ts";

// How an agent answers in each Slack channel of its app's install, and in
// its DMs (94S-177). One write sets one channel; the DM binding is the
// install's single row with no channel id.

/** `ambient` is in the binding contract but not yet something anyone sets. */
export const SLACK_BINDING_MODE_VALUES = ["off", "mention"] as const;
export const slackBindingModeSchema = z.enum(SLACK_BINDING_MODE_VALUES);

// Slack's channel ids (`C…`, `G…`); names are resolved by the console.
const slackChannelIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9]+$/);

/**
 * Replaces the binding for one channel, or the install's DM binding, whole:
 * a missing `ceiling` is the default one. `home: true` moves the agent's
 * home here.
 */
export const putSlackBindingRequestSchema = z
  .object({
    channel_id: slackChannelIdSchema.nullable(),
    channel_kind: surfaceChannelKindSchema,
    mode: slackBindingModeSchema,
    home: z.boolean().default(false),
    ceiling: surfaceCeilingSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if ((request.channel_kind === "dm") !== (request.channel_id === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["channel_id"],
        message: "a dm binding names no channel, and only a dm binding",
      });
    }
    if (request.home && request.channel_kind === "dm") {
      ctx.addIssue({
        code: "custom",
        path: ["home"],
        message: "a dm binding is never home",
      });
    }
  });

export const putSlackBindingResponseSchema = z
  .object({
    slack_binding: surfaceBindingSchema,
    receipt_id: receiptIdSchema,
  })
  .strict();

export const SLACK_BINDING_LIST_LIMIT = 500;

/** The agent's live bindings: home first, then oldest first. */
export const listSlackBindingsResponseSchema = z
  .object({
    items: z.array(surfaceBindingSchema).max(SLACK_BINDING_LIST_LIMIT),
  })
  .strict();

// Shown as the API's error message, so the web screen says the same.
export const SLACK_BINDING_MESSAGES = {
  notInstalled:
    "이 에이전트는 Slack 앱에 연결돼 있지 않아요. 앱을 연결한 뒤 채널을 설정하세요",
  conflict:
    "같은 채널 설정이 동시에 바뀌었어요. 목록을 새로 읽고 다시 시도하세요",
} as const;

export type SlackBindingMode = z.infer<typeof slackBindingModeSchema>;
export type PutSlackBindingRequest = z.infer<
  typeof putSlackBindingRequestSchema
>;
export type PutSlackBindingResponse = z.infer<
  typeof putSlackBindingResponseSchema
>;
export type ListSlackBindingsResponse = z.infer<
  typeof listSlackBindingsResponseSchema
>;
