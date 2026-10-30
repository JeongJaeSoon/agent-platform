import {
  GITHUB_AGENT_REF_PREFIX,
  GITHUB_CEILING_NONE,
  type GitHubRefusal,
  githubAllowedBy,
  githubEffectiveFeatures,
  githubPermissionsFor,
} from "@werft-ai/contracts";
import { type GitCredential, repoRefOf } from "../ports/forge.ts";
import {
  type GitHubConnections,
  type GitHubGate,
  GitHubGateError,
  type GitHubGateReceipt,
  type GitHubGateStore,
  type GitHubGrant,
  GitHubPermissionError,
  GitHubUnavailableError,
  type GitHubWork,
} from "../ports/github-gate.ts";
import type { SessionCatalog } from "./catalog.ts";

/**
 * The one place a GitHub credential is issued (design github-agent.md §3).
 * Every grant reads the session, its release and agent again, so a switch
 * turned off or a ceiling lowered refuses the next piece of work even when
 * the connection still caches a token for it.
 */
export function createGitHubGate(deps: {
  store: GitHubGateStore;
  catalog: SessionCatalog;
  connections: GitHubConnections;
}): GitHubGate {
  const { store, catalog, connections } = deps;

  return {
    async grant(work: GitHubWork): Promise<GitHubGrant | null> {
      const context = await store.context(work.sessionId);
      if (context === null) {
        throw new GitHubUnavailableError("The session was not found");
      }
      const operation: GitHubGateReceipt["operation"] =
        work.purpose === "dispatch"
          ? "dispatch_workflow"
          : work.purpose === "rerun"
            ? "rerun_workflow"
            : work.purpose === "review"
              ? "review_pull_request"
              : "mint_github_token";
      const fields: Record<string, unknown> = {
        session_id: context.sessionId,
        agent_id: context.agent?.id ?? null,
        agent_release_id: context.release?.id ?? null,
        repository_id: context.repositoryId,
        purpose: work.purpose,
        ...(work.workflow === undefined
          ? {}
          : { workflow: work.workflow.file, ref: work.workflow.ref }),
        ...(work.runId === undefined ? {} : { run_id: work.runId }),
        ...(work.review === undefined
          ? {}
          : {
              number: work.review.number,
              commit_id: work.review.commitId,
              event: work.review.event,
            }),
      };
      const receipt = (
        status: GitHubGateReceipt["status"],
        result: Record<string, unknown>,
        refusal: GitHubRefusal | null,
        as: GitHubGateReceipt["operation"],
      ) =>
        store.recordReceipt({
          ownerId: context.ownerId,
          sessionId: context.sessionId,
          actor:
            work.actor !== undefined
              ? work.actor
              : context.startedBy === null
                ? null
                : {
                    principal: { kind: "user", id: context.startedBy },
                    actor_user_id: context.startedBy,
                    agent_id: null,
                  },
          operation: as,
          status,
          result: { ...fields, ...result },
          error:
            refusal === null
              ? null
              : {
                  code: "GITHUB_REFUSED",
                  message: `GitHub work refused: ${refusal}`,
                },
        });
      const refuse = async (reason: GitHubRefusal): Promise<never> => {
        const receiptId = await receipt(
          "failed",
          { reason_code: reason },
          reason,
          operation,
        );
        throw new GitHubGateError(reason, receiptId);
      };

      const { repositoryId } = context;
      if (repositoryId === null) return await refuse("repository_none");
      const entry = Object.hasOwn(catalog.repositories, repositoryId)
        ? catalog.repositories[repositoryId]
        : undefined;
      if (
        entry === undefined ||
        context.repository === null ||
        entry.url !== context.repository.url ||
        entry.branch !== context.repository.branch
      ) {
        throw new GitHubUnavailableError("The session's repository moved");
      }
      const author = connections(repositoryId, "author");
      // Not on GitHub: the catalog's own credential, as before the gate.
      if (author === null && entry.auth?.kind !== "github_app") return null;

      const settings = context.release?.github ?? null;
      if (settings === "invalid") {
        return await refuse("github_settings_unsupported");
      }
      // Reading a pull request the platform recorded is not the agent's
      // work: no switch, scope, feature or ceiling applies (§10).
      const platformRead = work.purpose === "outcome_refresh";
      if (!platformRead) {
        if (context.agent !== null && !context.agent.githubEnabled) {
          return await refuse("github_disabled");
        }
        if (
          settings !== null &&
          !settings.repositories.includes(repositoryId)
        ) {
          return await refuse("repository_not_allowed");
        }
        if (settings !== null && author?.kind === "pat") {
          return await refuse("app_required");
        }
      }
      const features = githubEffectiveFeatures(
        settings?.features ?? GITHUB_CEILING_NONE,
        context.ceiling,
      );
      const needs = githubPermissionsFor(work.purpose, features);
      if (!platformRead && needs.feature !== null) {
        if (settings === null || !settings.features[needs.feature]) {
          return await refuse("feature_off");
        }
        if (!features[needs.feature]) {
          return await refuse("over_workspace_ceiling");
        }
        if (author?.kind === "pat") return await refuse("app_required");
        if (author !== null && !author.githubCom) {
          return await refuse("github_host_unsupported");
        }
      }

      let allowedBy: GitHubGrant["allowedBy"] = null;
      if (work.purpose === "dispatch" || work.purpose === "rerun") {
        let target = work.workflow;
        if (work.purpose === "rerun") {
          const recorded =
            work.runId === undefined
              ? null
              : await store.findDispatch(repositoryId, work.runId);
          if (recorded === null) return await refuse("run_ref_unprovable");
          target = { file: recorded.workflow, ref: recorded.ref };
          fields.workflow = recorded.workflow;
          fields.ref = recorded.ref;
        }
        if (target === undefined) return await refuse("workflow_not_allowed");
        if (target.ref.startsWith(GITHUB_AGENT_REF_PREFIX)) {
          return await refuse("agent_ref_refused");
        }
        allowedBy = githubAllowedBy(
          settings === null ? [] : settings.actions_allow,
          target.file,
          target.ref,
          entry.branch,
        );
        if (allowedBy === null) return await refuse("workflow_not_allowed");
        fields.allowed_by = allowedBy;
      }

      const connection =
        needs.role === "author"
          ? author
          : connections(repositoryId, "reviewer");
      if (connection === null) {
        if (needs.role === "reviewer") return await refuse("no_reviewer_app");
        throw new GitHubUnavailableError(
          "The repository's GitHub App is not registered",
        );
      }
      const repo = repoRefOf(entry.url);
      if (repo === null) {
        throw new GitHubUnavailableError("The repository URL names no repo");
      }
      let gitCredential: GitCredential;
      let fresh: boolean;
      try {
        ({ credential: gitCredential, fresh } = await connection.credential(
          repo,
          needs.permissions,
        ));
      } catch (error) {
        if (error instanceof GitHubPermissionError) {
          return await refuse("app_permission_missing");
        }
        throw error;
      }
      if (fresh) {
        await receipt(
          "succeeded",
          {
            role: needs.role,
            app_id: connection.appId,
            permissions: needs.permissions,
            expires_at: gitCredential.expiresAt?.toISOString() ?? null,
          },
          null,
          "mint_github_token",
        );
      }
      return {
        role: needs.role,
        repo,
        permissions: needs.permissions,
        gitCredential,
        api: connection.api(repo, gitCredential),
        allowedBy,
        context: {
          ownerId: context.ownerId,
          sessionId: context.sessionId,
          agentId: context.agent?.id ?? null,
          agentReleaseId: context.release?.id ?? null,
          repositoryId,
        },
      };
    },
  };
}
