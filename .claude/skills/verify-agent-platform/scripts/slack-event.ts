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

const [agentId, mode] = process.argv.slice(1);
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
          event_id: mode === "bot" ? "EvVerifyBot" : "EvVerify1",
          event: {
            type: "app_mention",
            user: "U0MOCK",
            channel: "C0VERIFY",
            ts: "1792800000.000001",
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
