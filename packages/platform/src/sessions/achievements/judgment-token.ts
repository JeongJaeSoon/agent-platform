import { createHash, randomBytes } from "node:crypto";
import type {
  ClaimedJudgment,
  JudgmentEgressStore,
} from "./achievement-judgment-store.ts";

export const JUDGMENT_TOKEN_PREFIX = "wej_";

export function hashJudgmentToken(token: string): Uint8Array {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * The claimed judgment's egress token, good for the judgment route only and
 * only while the judge holds the judgment's lease; null once it does not.
 */
export async function issueJudgmentToken(
  store: Pick<JudgmentEgressStore, "issueToken">,
  judgment: ClaimedJudgment,
): Promise<string | null> {
  const token = `${JUDGMENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return (await store.issueToken(judgment, hashJudgmentToken(token)))
    ? token
    : null;
}

/** The UTC midnight the day's judgment budget counts from. */
export function utcDayStart(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

export function nextUtcDay(at: Date): Date {
  const start = utcDayStart(at);
  return new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate() + 1,
    ),
  );
}
