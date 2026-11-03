/**
 * Where a Slack push approval's follow-up turn goes: `now` asks the caller to
 * queue it, `held` keeps it for the end of the turn running now (queued then
 * only if no pull request is recorded), `pull_request` drops it because the
 * push's branch already has one.
 */
export interface PushFollowUpStore {
  hold(input: {
    sessionId: string;
    pushRequestId: string;
    message: string;
  }): Promise<"now" | "held" | "pull_request">;
}
