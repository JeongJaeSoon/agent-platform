// Runs inside this verification project's API container; never returns credentials.
import { createHmac } from "node:crypto";
import * as schema from "@werft-ai/db";
import {
  createPostgresSecretStore,
  createPostgresSlackAppStore,
} from "@werft-ai/db";
import { createSlackSigningSecrets } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  DEFAULT_CONFIG_DIR,
  loadSecretKey,
  secretsManagerReader,
} from "./apps/control-host/src/api/catalog-config.ts";

const [agentId, mode, channel = "C0VERIFY", seq = "1"] = process.argv.slice(1);
// `mention` and `plain` are top-level posts by U0MOCK in `channel`, with
// or without a mention; each sequence number is its own event and thread.
// `reply` answers, unmentioned, in the thread that number opened.
const posted = mode === "mention" || mode === "plain" || mode === "reply";
const root = `${1792800000 + Number(seq)}.000001`;
const ts = !posted
  ? "1792800000.000001"
  : mode === "reply"
    ? `${1792800000 + Number(seq)}.000002`
    : root;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const db = drizzle(pool, { schema });
  const secretKey = await loadSecretKey({
    dir: process.env.PLATFORM_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
    env: process.env,
    readSecret: secretsManagerReader(process.env),
  });
  if (!secretKey) throw new Error("throwaway master key required");
  const app = await createSlackSigningSecrets({
    apps: createPostgresSlackAppStore(db, secretKey),
    secrets: createPostgresSecretStore(db, secretKey),
  }).forAgent(agentId);
  if (!app) throw new Error("create agent Slack app first");
  const payload =
    mode === "challenge"
      ? { type: "url_verification", challenge: "verify-challenge" }
      : {
          type: "event_callback",
          api_app_id: app.appId,
          team_id: "T0MOCK",
          event_id:
            mode === "bot"
              ? "EvVerifyBot"
              : posted
                ? `EvVerify${mode}${channel}${seq}`
                : "EvVerify1",
          event:
            mode === "reply"
              ? {
                  type: "message",
                  channel_type: "channel",
                  user: "U0MOCK",
                  channel,
                  ts,
                  thread_ts: root,
                  text: "verify thread reply",
                }
              : mode === "plain"
                ? {
                    type: "message",
                    channel_type: "channel",
                    user: "U0MOCK",
                    channel,
                    ts,
                    text: "verify plain post",
                  }
                : {
                    type: "app_mention",
                    user: "U0MOCK",
                    channel: posted ? channel : "C0VERIFY",
                    ts,
                    text: "verify inbox",
                    ...(mode === "bot" ? { bot_id: "B0VERIFY" } : {}),
                  },
        };
  const body = mode === "malformed" ? "{" : JSON.stringify(payload);
  const timestamp = String(
    Math.floor(Date.now() / 1000) - (mode === "stale" ? 301 : 0),
  );
  const signature = `v0=${createHmac("sha256", app.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const response = await fetch(
    `http://127.0.0.1:3000/v1/slack/events/${agentId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature":
          mode === "bad" ? `v0=${"0".repeat(64)}` : signature,
      },
      body,
    },
  );
  console.log(await response.text());
  console.log(response.status);
} finally {
  await pool.end();
}
