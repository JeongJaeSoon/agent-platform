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
  Alert,
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  FieldDescription,
  FieldLabel,
  formatTimestamp,
  NativeSelect,
  NativeSelectOption,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { membersQuery, profilesQuery, queryKeys } from "../../api/queries.ts";
import { useHasPermission, useRole } from "../../auth/guard.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { errorKey, useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import { MUTED, SECTION, SECTION_TITLE } from "./classes.ts";
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
  const [open, setOpen] = useState(false);
  const submitted = useRef(false);
  // Only roles that list members get names; anyone else reads "a member".
  const listsMembers = useHasPermission("member.manage");
  const members = useQuery({ ...membersQuery(client), enabled: listsMembers });
  const names = new Map(
    (members.data?.items ?? []).map((m) => [m.user_id, m.display_name]),
  );
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
    // Either way the result shows under the table, where focus goes.
    onSettled: () => {
      submitted.current = true;
      setOpen(false);
    },
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
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className={SECTION_TITLE}>
          {t("agent.releases.title")}
        </h2>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <Plus aria-hidden="true" />
              {t("agent.releases.new")}
            </Button>
          </DialogTrigger>
          <DialogContent
            className="sm:max-w-[32.5rem]"
            // The result line below the table takes the keyboard instead.
            onCloseAutoFocus={(event) => {
              if (submitted.current) event.preventDefault();
              submitted.current = false;
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("agent.releases.new")}</DialogTitle>
              <DialogDescription>{t("agent.releases.intro")}</DialogDescription>
            </DialogHeader>
            <form className="flex flex-col gap-4" onSubmit={submit}>
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
              {mismatch ? (
                <Alert asChild variant="amber">
                  <output>
                    {t("agent.releases.modelMismatch", {
                      card: cardModel,
                      profile: profileModel,
                    })}
                  </output>
                </Alert>
              ) : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    {t("common.cancel")}
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  disabled={
                    release.isPending || versionId === "" || profile === ""
                  }
                >
                  {release.isPending
                    ? t("agent.releases.creating")
                    : t("agent.releases.create")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {result}
      {ordered.length === 0 ? (
        <EmptyState
          title={t("agent.releases.empty")}
          description={t("agent.releases.emptyBody")}
        />
      ) : (
        <TableContainer label={t("agent.releases.title")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="nowrap">
                  {t("agent.releases.colVersion")}
                </TableHead>
                <TableHead variant="nowrap">
                  {t("agent.releases.colStatus")}
                </TableHead>
                <TableHead>{t("agent.releases.profile")}</TableHead>
                <TableHead className="whitespace-nowrap">
                  {t("agent.releases.colBy")}
                </TableHead>
                <TableHead variant="nowrap">
                  {t("agent.releases.colAt")}
                </TableHead>
                <TableHead variant="actions">
                  <span className="sr-only">
                    {t("agent.releases.colActions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordered.map((item) => {
                const active = item.id === detail.agent.active_release_id;
                const label = t("agent.releaseLabel", {
                  version: versionNo(item.version_id) ?? "?",
                  profile: item.runtime_profile_id,
                });
                return (
                  <TableRow key={item.id} data-active={active}>
                    <TableCell variant="nowrap" className="font-medium">
                      {t("agent.versionShort", {
                        version: versionNo(item.version_id) ?? "?",
                      })}
                    </TableCell>
                    <TableCell variant="nowrap">
                      <Badge variant={active ? "green" : "gray"}>
                        {active
                          ? t("agent.releases.active")
                          : item.approved_at
                            ? t("agent.releases.previous")
                            : t("agent.releases.never")}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-caption">
                      {item.runtime_profile_id}
                    </TableCell>
                    <TableCell>
                      {(item.created_by
                        ? names.get(item.created_by)
                        : undefined) ?? t("agent.releases.byMember")}
                    </TableCell>
                    <TableCell variant="nowrap" className="tabular-nums">
                      {formatTimestamp(item.created_at, locale)}
                    </TableCell>
                    <TableCell variant="actions">
                      {active ? null : (
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
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
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
