import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@werft-ai/client";
import type {
  ListPushRequestsResponse,
  PushIntent,
  PushRequest,
  SessionDetail,
} from "@werft-ai/contracts";
import { sessionGithubWorkQuery } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Code,
  Heading,
  RelativeTime,
  RowLines,
  RowList,
  RowListItem,
  Text,
} from "@werft-ai/ui";
import { useId } from "react";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";

const REQUEST_BADGE = {
  requested: "blue",
  approved: "blue",
  pushing: "blue",
  pushed: "green",
  rejected: "gray",
  failed: "red",
} as const;

type Row =
  | { kind: "request"; at: string; request: PushRequest }
  | { kind: "intent"; at: string; intent: PushIntent };

/**
 * Rows of the list: every push request, plus the intents that have no
 * request (still waiting, or ended without one). A `requested` intent is its
 * request's row already.
 */
function rowsOf(data: ListPushRequestsResponse): Row[] {
  const rows: Row[] = [
    ...data.items.map(
      (request): Row => ({
        kind: "request",
        at: request.requested_at,
        request,
      }),
    ),
    ...(data.intents ?? [])
      .filter((intent) => intent.status !== "requested")
      .map(
        (intent): Row => ({ kind: "intent", at: intent.created_at, intent }),
      ),
  ];
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function RequestRow({ request }: { readonly request: PushRequest }) {
  const { t, locale } = useI18n();
  return (
    <RowListItem>
      <RowLines>
        <Text as="span" className="flex min-w-0 flex-wrap items-center gap-2">
          <Code className="[overflow-wrap:anywhere]">
            {request.repository_id} ← {request.target_branch}
          </Code>
          <Badge variant={REQUEST_BADGE[request.state]}>
            {t(`session.github.state.${request.state}`)}
          </Badge>
          {!request.pr_state ? null : (
            <Badge variant="gray">
              {t(`session.github.prState.${request.pr_state}`)}
            </Badge>
          )}
        </Text>
        <Text as="span" variant="meta">
          <RelativeTime value={request.requested_at} locale={locale} />
        </Text>
      </RowLines>
    </RowListItem>
  );
}

function IntentRow({ intent }: { readonly intent: PushIntent }) {
  const { t, locale } = useI18n();
  return (
    <RowListItem>
      <RowLines>
        <Text as="span" className="flex min-w-0 flex-wrap items-center gap-2">
          <Code className="[overflow-wrap:anywhere]">
            {intent.repository_id} ← {intent.target_branch}
          </Code>
          <Badge variant={intent.status === "failed" ? "red" : "gray"}>
            {t(`session.github.intent.${intent.status}`)}
          </Badge>
        </Text>
        <Text as="span" variant="meta">
          {intent.refusal_code === null
            ? null
            : `${t(`session.github.reason.${intent.refusal_code}`)} · `}
          <RelativeTime value={intent.created_at} locale={locale} />
        </Text>
      </RowLines>
    </RowListItem>
  );
}

/**
 * The session's GitHub work: its push requests with their pull request
 * stage, and the pushes a turn asked for that have no request yet or ended
 * without one, each with why.
 */
export function SessionGitHubWork({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const titleId = useId();
  const work = useQuery(
    sessionGithubWorkQuery(client, session.id, {
      enabled: Boolean(session.repository),
    }),
  );
  if (work.error && !isApiError(work.error, "NOT_FOUND")) {
    return (
      <LoadFailure error={work.error} onRetry={() => void work.refetch()} />
    );
  }
  const rows = work.data === undefined ? [] : rowsOf(work.data);
  if (!session.repository || rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={titleId}>
      <Heading id={titleId}>{t("session.github.title")}</Heading>
      <Text variant="sub">{t("session.github.description")}</Text>
      <RowList variant="joined">
        {rows.map((row) =>
          row.kind === "request" ? (
            <RequestRow key={row.request.id} request={row.request} />
          ) : (
            <IntentRow key={row.intent.id} intent={row.intent} />
          ),
        )}
      </RowList>
    </section>
  );
}
