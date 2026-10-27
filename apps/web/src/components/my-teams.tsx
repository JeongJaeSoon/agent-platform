import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { isApiError } from "@werft-ai/client";
import { useAgentPlatform } from "@werft-ai/react";
import {
  EmptyState,
  RowList,
  RowListItem,
  Link as TextLink,
} from "@werft-ai/ui";
import { type ReactNode, useId } from "react";
import { myTeamsQuery } from "../api/queries.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { LoadFailure } from "./load-failure.tsx";
import { OPENS_ROW, ROW_LINK } from "./row-link.ts";

export const SECTION = "flex flex-col gap-[var(--ap-space-block)]";
export const SECTION_TITLE = "m-0 font-semibold text-body";
export const MUTED = "m-0 text-muted-foreground";

/**
 * The teams the viewer is in, each linking to its page: a team's members
 * read it, and only managers change it (D23, 94S-719).
 */
export function MyTeams({
  showEmpty,
  action,
}: {
  /** Off where an empty section would only be noise (home). */
  readonly showEmpty: boolean;
  /** Beside the title, e.g. home's link to the teams list. */
  readonly action?: ReactNode;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const teams = useQuery(myTeamsQuery(client));
  const titleId = useId();
  if (teams.isPending) return null;
  // An API key session belongs to no team; that is not an error to show.
  if (isApiError(teams.error, "FORBIDDEN")) return null;
  const items = teams.data?.items ?? [];
  if (!teams.error && items.length === 0 && !showEmpty) return null;

  const title = (
    <h2 id={titleId} className={SECTION_TITLE}>
      {t("teams.mine.title")}
    </h2>
  );
  return (
    <section className={SECTION} aria-labelledby={titleId}>
      {action ? (
        <div className="flex min-h-7 items-center justify-between gap-3">
          {title}
          {action}
        </div>
      ) : (
        title
      )}
      {teams.error ? (
        <LoadFailure error={teams.error} onRetry={() => void teams.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t("teams.mine.empty")} />
      ) : (
        <>
          <p className={`${MUTED} text-sm`}>{t("teams.mine.intro")}</p>
          <RowList>
            {items.map((team) => (
              <RowListItem key={team.id} className={OPENS_ROW}>
                <TextLink
                  asChild
                  className={`${ROW_LINK} [overflow-wrap:anywhere]`}
                >
                  <Link
                    to="/members/teams/$teamId"
                    params={{ teamId: team.id }}
                  >
                    {team.name}
                  </Link>
                </TextLink>
              </RowListItem>
            ))}
          </RowList>
        </>
      )}
    </section>
  );
}
