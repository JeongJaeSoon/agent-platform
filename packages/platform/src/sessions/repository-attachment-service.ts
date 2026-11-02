import type { ReceiptActor, RepositoryAttachment } from "@werft-ai/contracts";
import type { GitHubGateStore } from "../ports/github-gate.ts";
import type {
  RepositoryAttachmentRow,
  RepositoryAttachmentStore,
} from "../ports/repository-attachments.ts";
import { additionalRepositoryAllowed } from "./additional-repositories.ts";
import type { SessionCatalog } from "./catalog.ts";
import { SessionServiceError } from "./session-service.ts";

/**
 * How long a call may take, from its start, before answering `pending`. The
 * authorizer listener that serves the call keeps Bun's default 10 second
 * idle timeout, which a silent wait counts against; past it the agent would
 * get a cut connection instead of an answer.
 */
export const ATTACH_WAIT_MS = 8_000;
const ATTACH_POLL_MS = 500;

export type AttachRepositoryInput = {
  sessionId: string;
  attemptId: string;
  actor: ReceiptActor;
  repositoryId: string;
};

function answer(
  row: RepositoryAttachmentRow,
  alreadyAttached: boolean,
): RepositoryAttachment {
  return {
    repository_id: row.repositoryId,
    status: row.status,
    branch: row.branch,
    commit: row.commit,
    failure: row.failure,
    already_attached: alreadyAttached,
    receipt_id: row.receiptId,
  };
}

/**
 * `attach_repository` (session-repository-attachment.md decision 3): the
 * release's list caps what may be attached, the row records it, and a worker
 * of the session fetches it. No person approves it (owner decision 3);
 * writing to it still waits for a push approval.
 */
export function createRepositoryAttachmentService(deps: {
  store: RepositoryAttachmentStore;
  context: Pick<GitHubGateStore, "context">;
  catalog: SessionCatalog;
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock in milliseconds. */
  now?: () => number;
}) {
  const { store, catalog } = deps;
  const waitMs = deps.waitMs ?? ATTACH_WAIT_MS;
  const pollMs = deps.pollMs ?? ATTACH_POLL_MS;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => performance.now());

  async function settled(
    sessionId: string,
    row: RepositoryAttachmentRow,
    deadline: number,
  ): Promise<RepositoryAttachmentRow> {
    let current = row;
    while (current.status === "pending" && now() + pollMs < deadline) {
      await sleep(pollMs);
      // A slow read is cut at the deadline and the last state answered.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        store.find(sessionId, row.repositoryId),
        new Promise<"late">((resolve) => {
          timer = setTimeout(
            () => resolve("late"),
            Math.max(0, deadline - now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (read === "late") break;
      current = read ?? current;
    }
    return current;
  }

  return {
    async attach(input: AttachRepositoryInput): Promise<RepositoryAttachment> {
      const deadline = now() + waitMs;
      const sessionId = input.sessionId.toLowerCase();
      const { repositoryId } = input;
      const context = await deps.context.context(sessionId);
      if (context === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      if (repositoryId === context.repositoryId) {
        return {
          repository_id: repositoryId,
          status: "attached",
          branch: context.repository?.branch ?? null,
          commit: null,
          failure: null,
          already_attached: true,
          receipt_id: null,
        };
      }
      const fields = {
        session_id: sessionId,
        attempt_id: input.attemptId,
        agent_id: context.agent?.id ?? null,
        agent_release_id: context.release?.id ?? null,
        repository_id: repositoryId,
      };
      const refuse = async (
        reason: "repository_not_allowed" | "attempt_ended",
      ): Promise<never> => {
        const code =
          reason === "repository_not_allowed"
            ? "GITHUB_REFUSED"
            : "STALE_EPOCH";
        const message =
          reason === "repository_not_allowed"
            ? `GitHub work refused: ${reason}`
            : "The attempt that asked has ended";
        const receiptId = await store.recordRefusal({
          ownerId: context.ownerId,
          sessionId,
          actor: input.actor,
          result: {
            ...fields,
            branch: null,
            commit: null,
            failure: null,
            reason_code: reason,
          },
          error: { code, message },
        });
        throw new SessionServiceError(code, message, undefined, {
          reason_code: reason,
          receipt_id: receiptId,
        });
      };
      // The cap alone, the attached list left out: attaching is what adds
      // to that list.
      const allowed = additionalRepositoryAllowed(
        catalog,
        {
          repositoryId: context.repositoryId,
          profileId: context.profileId,
          attached: null,
          github: context.release?.github ?? null,
          githubEnabled: context.agent?.githubEnabled ?? false,
        },
        repositoryId,
      );
      if (allowed === null) return await refuse("repository_not_allowed");
      const outcome = await store.request({
        ownerId: context.ownerId,
        sessionId,
        attemptId: input.attemptId,
        repositoryId,
        branch: allowed.branch,
        actor: input.actor,
        result: {
          ...fields,
          branch: allowed.branch,
          commit: null,
          failure: null,
          reason_code: null,
        },
      });
      if (outcome.outcome === "attempt_ended") {
        return await refuse("attempt_ended");
      }
      if (outcome.outcome === "preattached") {
        return {
          repository_id: repositoryId,
          status: "attached",
          branch: allowed.branch,
          commit: null,
          failure: null,
          already_attached: true,
          receipt_id: null,
        };
      }
      const row = await settled(sessionId, outcome.row, deadline);
      return answer(
        row,
        outcome.outcome === "unchanged" && outcome.row.status === "attached",
      );
    },
  };
}

export type RepositoryAttachmentService = ReturnType<
  typeof createRepositoryAttachmentService
>;
