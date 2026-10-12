import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { type ApiError, isApiError } from "../api/client.ts";
import { myTeamsQuery } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

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
  const { client } = useServices();
  const manages = useHasPermission("team.manage");
  const teams = useQuery(myTeamsQuery(client));
  const titleId = useId();
  if (teams.isPending) return null;
  // An API key session belongs to no team; that is not an error to show.
  if (isApiError(teams.error, "FORBIDDEN")) return null;
  const items = teams.data?.items ?? [];
  if (!teams.error && items.length === 0 && !showEmpty) return null;

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("teams.mine.title")}</h2>
      {teams.error ? (
        <p className="web-form__error" role="alert">
          {t(errorKey((teams.error as ApiError).code))}
        </p>
      ) : items.length === 0 ? (
        <p className="web-page__empty">{t("teams.mine.empty")}</p>
      ) : (
        <>
          <p className="web-field__hint">{t("teams.mine.intro")}</p>
          <ul className="web-list">
            {items.map((team) => (
              <li key={team.id} className="web-list__item">
                {manages ? (
                  <Link
                    to="/teams/$teamId"
                    params={{ teamId: team.id }}
                    className="web-table__primary"
                  >
                    {team.name}
                  </Link>
                ) : (
                  <span className="web-table__primary">{team.name}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
