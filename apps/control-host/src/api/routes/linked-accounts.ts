import {
  LINK_MESSAGES,
  linkedAccountParamsSchema,
  listLinkedAccountsResponseSchema,
  slackLinkCallbackRequestSchema,
  slackLinkCallbackResponseSchema,
  startSlackLinkResponseSchema,
  unlinkAccountResponseSchema,
} from "@agent-platform/contracts";
import type { StructuredLogger } from "@agent-platform/observability";
import type { LinkedAccountService } from "@agent-platform/platform";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import {
  consumeSlackLinkState,
  exchangeSlackCode,
  issueSlackLinkState,
  SLACK_LINK_TTL_MS,
  type SlackOidcConfig,
  SlackOidcRejectedError,
  SlackOidcUnavailableError,
  slackAuthorizeUrl,
} from "../slack-link.ts";
import { mapped, requireParams } from "./errors.ts";

export interface LinkedAccountRouteDeps {
  service: LinkedAccountService;
  /** Null: Sign in with Slack is not configured on this installation. */
  slack: SlackOidcConfig | null;
  logger?: StructuredLogger;
}

function slackConfigured(deps: LinkedAccountRouteDeps): SlackOidcConfig {
  if (!deps.slack) {
    throw new ApiHttpError(
      503,
      "BACKEND_UNAVAILABLE",
      "Sign in with Slack is not configured on this installation",
    );
  }
  return deps.slack;
}

export function registerLinkedAccountRoutes(
  router: ApiRouter,
  deps: LinkedAccountRouteDeps,
) {
  apiRoute(router, "startSlackLink", async (context) => {
    const caller = context.get("caller");
    const slack = slackConfigured(deps);
    const { userId, teams } = await mapped(() =>
      deps.service.beginSlackLink(caller),
    );
    const expiresAt = new Date(Date.now() + SLACK_LINK_TTL_MS);
    const issued = issueSlackLinkState(context, userId, expiresAt);
    return jsonWithSchema(context, startSlackLinkResponseSchema, {
      authorize_url: slackAuthorizeUrl(
        slack,
        issued,
        teams.length === 1 ? (teams[0] ?? null) : null,
      ),
      expires_at: expiresAt.toISOString(),
    });
  });

  apiRoute(router, "slackLinkCallback", async (context) => {
    const caller = context.get("caller");
    const slack = slackConfigured(deps);
    const body = await parseJsonBody(context, slackLinkCallbackRequestSchema);
    const userId = await mapped(() => deps.service.personFor(caller));
    const issued = consumeSlackLinkState(context, body.state, userId);
    if (!issued) {
      throw new ApiHttpError(400, "BAD_REQUEST", LINK_MESSAGES.expired);
    }
    let verified: Awaited<ReturnType<typeof exchangeSlackCode>>;
    try {
      verified = await exchangeSlackCode(slack, body.code, issued.nonce);
    } catch (error) {
      if (error instanceof SlackOidcRejectedError) {
        deps.logger?.warn("Slack link refused by the IdP", {
          reason: error.message,
        });
        throw new ApiHttpError(400, "BAD_REQUEST", LINK_MESSAGES.expired);
      }
      if (error instanceof SlackOidcUnavailableError) {
        deps.logger?.warn("Slack link could not reach Slack", {
          reason: error.message,
        });
        throw new ApiHttpError(
          503,
          "BACKEND_UNAVAILABLE",
          "Slack could not be reached, try again later",
          true,
        );
      }
      throw error;
    }
    const linked = await mapped(() =>
      deps.service.linkSlackAccount(caller, verified),
    );
    deps.logger?.info("Slack account linked", {
      user_id: linked.linked_account.user_id,
      linked_account_id: linked.linked_account.id,
    });
    return jsonWithSchema(
      context,
      slackLinkCallbackResponseSchema,
      linked,
      201,
    );
  });

  apiRoute(router, "listLinkedAccounts", async (context) => {
    const page = await mapped(() =>
      deps.service.listLinkedAccounts(context.get("caller")),
    );
    return jsonWithSchema(context, listLinkedAccountsResponseSchema, page);
  });

  apiRoute(router, "unlinkAccount", async (context) => {
    const params = requireParams(context, linkedAccountParamsSchema);
    const receipt = await mapped(() =>
      deps.service.unlinkAccount(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, unlinkAccountResponseSchema, receipt);
  });
}
