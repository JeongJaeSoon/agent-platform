import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AgentDetail,
  AgentRelease,
  CreateAgentReleaseResponse,
  ProfileSummary,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  cn,
  EmptyState,
  Field,
  FieldDescription,
  FieldLabel,
  formatTimestamp,
  NativeSelect,
  NativeSelectOption,
  RowLines,
  RowList,
  RowListItem,
} from "@werft-ai/ui";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { profilesQuery, queryKeys } from "../../api/queries.ts";
import { useRole } from "../../auth/guard.tsx";
import { NOTICE } from "../../components/auth-page.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { errorKey, useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import {
  FORM_INLINE,
  MUTED,
  PRIMARY,
  SECONDARY,
  SECTION,
  SECTION_TITLE,
} from "./classes.ts";
import { latestVersion, VersionSelect } from "./versions.tsx";

export function Releases({
  detail,
  picked,
  onPick,
  versionNo,
  result,
  onOutcome,
  activating,
  onActivate,
}: {
  readonly detail: AgentDetail;
  /** The version to release; null offers the latest. */
  readonly picked: string | null;
  readonly onPick: (versionId: string) => void;
  readonly versionNo: (versionId: string) => number | undefined;
  /** Release and activation results, between the form and the list. */
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
  readonly activating: string | undefined;
  readonly onActivate: (release: AgentRelease) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const titleId = useId();
  const latest = latestVersion(detail);
  const versionId = picked ?? latest?.id ?? "";
  const profiles = useQuery(profilesQuery(client));
  const [chosen, setProfile] = useState(
    detail.releases.at(-1)?.runtime_profile_id ?? "",
  );
  const cardModel = detail.versions.find((v) => v.id === versionId)?.card.model;
  // A profile the catalog no longer has cannot be released again; without
  // a usable choice, offer one that runs the card's model.
  const items = profiles.data?.items ?? [];
  const profile = items.some((item) => item.id === chosen)
    ? chosen
    : ((items.find((item) => item.model === cardModel) ?? items[0])?.id ?? "");
  const ordered = [...detail.releases].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
  // The server refuses a release whose profile runs another model than the
  // card names; say so before the request.
  const profileModel = items.find((item) => item.id === profile)?.model;
  const mismatch =
    cardModel !== undefined &&
    profileModel !== undefined &&
    cardModel !== profileModel;

  const release = useMutation<CreateAgentReleaseResponse, ApiError>({
    mutationFn: () =>
      unwrap(
        client.POST("/v1/agents/{id}/releases", {
          params: { path: { id: detail.agent.id } },
          body: { version_id: versionId, runtime_profile_id: profile },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (result) => {
      onOutcome({
        kind: "notice",
        text: result.created
          ? t("agent.releaseCreated", {
              version: versionNo(result.release.version_id) ?? "?",
            })
          : t("agent.releaseExisted"),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agent(detail.agent.id),
      });
    },
    onError: (error) =>
      onOutcome({ kind: "error", text: agentRefusal(t, error, role) }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    release.mutate();
  };

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <h2 id={titleId} className={SECTION_TITLE}>
        {t("agent.releases.title")}
      </h2>
      <p className={MUTED}>{t("agent.releases.intro")}</p>
      <form className="flex flex-col items-start gap-3" onSubmit={submit}>
        <div className={FORM_INLINE}>
          <VersionSelect
            label={t("agent.releases.version")}
            versions={[...detail.versions].sort(
              (a, b) => b.version_no - a.version_no,
            )}
            value={versionId}
            onChange={onPick}
          />
          {profiles.isPending ? (
            <p className={MUTED}>{t("agent.releases.profilesLoading")}</p>
          ) : profiles.error ? (
            <p className="m-0 text-destructive text-sm" role="alert">
              {t("agent.releases.profilesFailed", {
                reason: t(errorKey((profiles.error as ApiError).code)),
              })}
            </p>
          ) : (
            <ProfileSelect
              label={t("agent.releases.profile")}
              hint={t("agent.releases.profileHint")}
              profiles={items}
              cardModel={cardModel}
              value={profile}
              onChange={setProfile}
            />
          )}
        </div>
        {mismatch ? (
          <output className={NOTICE}>
            {t("agent.releases.modelMismatch", {
              card: cardModel,
              profile: profileModel,
            })}
          </output>
        ) : null}
        <Button
          type="submit"
          variant="outline"
          disabled={release.isPending || versionId === "" || profile === ""}
        >
          {release.isPending
            ? t("agent.releases.creating")
            : t("agent.releases.create")}
        </Button>
      </form>
      {result}
      {ordered.length === 0 ? (
        <EmptyState title={t("agent.releases.empty")} />
      ) : (
        <RowList>
          {ordered.map((item) => {
            const active = item.id === detail.agent.active_release_id;
            const label = t("agent.releaseLabel", {
              version: versionNo(item.version_id) ?? "?",
              profile: item.runtime_profile_id,
            });
            return (
              <RowListItem
                key={item.id}
                className={cn(
                  active && "border-[var(--ap-tone-positive-border)]",
                )}
                data-active={active}
              >
                <RowLines>
                  <span className={PRIMARY}>{label}</span>
                  <span className={SECONDARY}>
                    {formatTimestamp(item.created_at, locale)} ·{" "}
                    {item.approved_at
                      ? t("agent.releases.approved", {
                          at: formatTimestamp(item.approved_at, locale),
                        })
                      : t("agent.releases.notApproved")}
                  </span>
                </RowLines>
                {active ? (
                  <Badge variant="green">{t("agent.releases.active")}</Badge>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={activating !== undefined}
                    aria-label={t("agent.releases.activateFor", {
                      release: label,
                    })}
                    onClick={() => onActivate(item)}
                  >
                    {activating === item.id
                      ? t("agent.releases.activating")
                      : t("agent.releases.activate")}
                  </Button>
                )}
              </RowListItem>
            );
          })}
        </RowList>
      )}
    </section>
  );
}

function ProfileSelect({
  label,
  hint,
  profiles,
  cardModel,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly profiles: readonly ProfileSummary[];
  readonly cardModel: string | undefined;
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field className="w-auto max-w-full">
      <FieldLabel>{label}</FieldLabel>
      <NativeSelect
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {profiles.map((profile) => (
          <NativeSelectOption key={profile.id} value={profile.id}>
            {t(
              cardModel !== undefined && profile.model !== cardModel
                ? "agent.releases.profileOptionMismatch"
                : "agent.releases.profileOption",
              { profile: profile.id, model: profile.model },
            )}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>{hint}</FieldDescription>
      <FieldDescription>{t("agent.releases.profileUnlisted")}</FieldDescription>
    </Field>
  );
}
