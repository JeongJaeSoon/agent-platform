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
import { useId } from "react";
import { myTeamsQuery } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { LoadFailure } from "./load-failure.tsx";

export const SECTION = "flex flex-col gap-[var(--ap-space-block)]";
export const SECTION_TITLE = "m-0 font-semibold text-body";
export const MUTED = "m-0 text-muted-foreground";

/**
 * The teams the viewer is in. A team links to its page only for those who
 * may open it; everyone else sees the name alone (D23).
 */
export function MyTeams({
  showEmpty,
}: {
  /** Off where an empty section would only be noise (home). */
  readonly showEmpty: boolean;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const manages = useHasPermission("team.manage");
  const teams = useQuery(myTeamsQuery(client));
  const titleId = useId();
  if (teams.isPending) return null;
  // An API key session belongs to no team; that is not an error to show.
  if (isApiError(teams.error, "FORBIDDEN")) return null;
  const items = teams.data?.items ?? [];
  if (!teams.error && items.length === 0 && !showEmpty) return null;

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <h2 id={titleId} className={SECTION_TITLE}>
        {t("teams.mine.title")}
      </h2>
      {teams.error ? (
        <LoadFailure error={teams.error} onRetry={() => void teams.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t("teams.mine.empty")} />
      ) : (
        <>
          <p className={`${MUTED} text-sm`}>{t("teams.mine.intro")}</p>
          <RowList>
            {items.map((team) => (
              <RowListItem key={team.id}>
                {manages ? (
                  <TextLink asChild className="[overflow-wrap:anywhere]">
                    <Link
                      to="/members/teams/$teamId"
                      params={{ teamId: team.id }}
                    >
                      {team.name}
                    </Link>
                  </TextLink>
                ) : (
                  <span className="font-medium [overflow-wrap:anywhere]">
                    {team.name}
                  </span>
                )}
              </RowListItem>
            ))}
          </RowList>
        </>
      )}
    </section>
  );
}
