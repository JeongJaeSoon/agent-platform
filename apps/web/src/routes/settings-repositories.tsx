import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@werft-ai/client";
import type {
  CreateSettingsRepositoryRequest,
  SettingsRepository,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Button,
  Code,
  EmptyState,
  Field,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  NativeSelect,
  NativeSelectOption,
  Page,
  RowAction,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  credentialText,
  entryActions,
  FormDialog,
  NarrowState,
  OriginBadge,
  type Outcome,
  OutcomeLine,
  SETTINGS_NARROW_COLUMNS,
  SecretInput,
  StateBadge,
  settingsRepositoriesQuery,
  useRowActions,
  useSettingsWrite,
} from "./settings-entries.tsx";

// id and source, URL and branch, credential, state, actions; a phone keeps
// the id (with the state) and the actions.
const COLUMNS = [
  "minmax(0,1fr) minmax(0,1.8fr) minmax(0,1fr) 128px 196px",
  SETTINGS_NARROW_COLUMNS,
] as const;

type AuthChoice = "none" | "bearer" | "basic";

export function RepositoriesScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const manages = useHasPermission("workspace.manage");
  const repositories = useQuery(settingsRepositoriesQuery(client, manages));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SettingsRepository | null>(null);
  const rows = useRowActions("repository", setOutcome);

  if (!manages)
    return (
      <Page title={t("settings.repos.title")}>
        <StatusScreen kind="forbidden" />
      </Page>
    );

  return (
    <Page
      title={t("settings.repos.title")}
      description={t("settings.repos.description")}
      actions={
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOutcome(null);
            setAdding(true);
          }}
        >
          <Plus aria-hidden="true" />
          {t("settings.repos.add")}
        </Button>
      }
    >
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        {repositories.isPending ? (
          <Skeleton width="60%" />
        ) : repositories.isError ? (
          <LoadFailure
            error={repositories.error}
            onRetry={() => void repositories.refetch()}
          />
        ) : repositories.data.items.length === 0 ? (
          <EmptyState title={t("settings.repos.empty")} />
        ) : (
          <GridTable
            aria-label={t("settings.repos.title")}
            columns={COLUMNS[0]}
            narrowAt={860}
            narrowColumns={COLUMNS[1]}
            framed={true}
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("settings.column.id")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("settings.repos.url")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("settings.column.credential")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("settings.column.state")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("settings.column.actions")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {repositories.data.items.map((item) => (
              <RepositoryRow
                key={`${item.origin}:${item.id}`}
                item={item}
                busy={rows.busy}
                onValue={() => rows.openValue(item.id)}
                onDisable={() => rows.openDisable(item.id)}
                onBranch={() => {
                  setOutcome(null);
                  setEditing(item);
                }}
              />
            ))}
          </GridTable>
        )}
        <OutcomeLine outcome={outcome} />
      </div>
      <AddRepository
        open={adding}
        onOpenChange={setAdding}
        onOutcome={setOutcome}
      />
      <EditBranch
        repository={editing}
        onClose={() => setEditing(null)}
        onOutcome={setOutcome}
      />
      {rows.dialogs}
    </Page>
  );
}

function RepositoryRow({
  item,
  busy,
  onValue,
  onDisable,
  onBranch,
}: {
  readonly item: SettingsRepository;
  readonly busy: boolean;
  readonly onValue: () => void;
  readonly onDisable: () => void;
  readonly onBranch: () => void;
}) {
  const { t } = useI18n();
  const actions = entryActions(item);
  return (
    <GridTableRow data-origin={item.origin}>
      <GridTableCell>
        <div className="flex min-w-0 flex-col items-start gap-[var(--ap-row-line-gap)]">
          <Code className="wrap-anywhere">{item.id}</Code>
          <OriginBadge origin={item.origin} />
          <NarrowState state={item.state} />
        </div>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <div className="flex min-w-0 flex-col gap-[var(--ap-row-line-gap)]">
          <Code className="wrap-anywhere">{item.url}</Code>
          <Text as="span" variant="meta">
            {t("settings.repos.branch")} <Code>{item.branch}</Code>
          </Text>
        </div>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <div className="flex min-w-0 flex-col gap-[var(--ap-row-line-gap)]">
          <Text as="span" variant="meta">
            {t(`settings.repos.auth.${item.auth_kind}`)}
            {item.username === undefined ? null : (
              <>
                {" · "}
                <Code>{item.username}</Code>
              </>
            )}
          </Text>
          {item.auth_kind === "none" ? null : (
            <Text as="span" variant="meta" className="wrap-anywhere">
              {credentialText(t, item.credential)}
            </Text>
          )}
        </div>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <StateBadge state={item.state} />
      </GridTableCell>
      <GridTableCell>
        {item.origin === "file" ? (
          <Text as="span" variant="meta">
            {t("settings.fileRow")}
          </Text>
        ) : (
          <div className="flex flex-wrap gap-1">
            {actions.disable && item.credential.source !== "external" ? (
              <RowAction
                disabled={busy}
                aria-label={t("settings.repos.editBranchFor", { id: item.id })}
                onClick={onBranch}
              >
                {t("settings.repos.editBranch")}
              </RowAction>
            ) : null}
            {actions.setValue ? (
              <RowAction
                disabled={busy}
                aria-label={t("settings.setValueFor", { id: item.id })}
                onClick={onValue}
              >
                {item.state === "needs_value"
                  ? t("settings.setFirstValue")
                  : t("settings.setValue")}
              </RowAction>
            ) : null}
            {actions.disable ? (
              <RowAction
                variant="danger"
                disabled={busy}
                aria-label={t("settings.disableFor", { id: item.id })}
                onClick={onDisable}
              >
                {t("settings.disable")}
              </RowAction>
            ) : null}
          </div>
        )}
      </GridTableCell>
    </GridTableRow>
  );
}

function AddRepository({
  open,
  onOpenChange,
  onOutcome,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useI18n();
  const [auth, setAuth] = useState<AuthChoice>("none");
  const [error, setError] = useState<string | null>(null);
  const create = useSettingsWrite(
    "repository",
    (client, body: CreateSettingsRepositoryRequest) =>
      unwrap(client.POST("/v1/installation/settings/repositories", { body })),
    {
      onDone: (answer) => {
        onOpenChange(false);
        onOutcome({
          kind: "notice",
          text: t("settings.done.created", { id: answer.id }),
        });
      },
      onRefused: setError,
    },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        if (!next) setAuth("none");
        onOpenChange(next);
      }}
      pending={create.isPending}
      title={t("settings.repos.add")}
      description={t("settings.immutable")}
      error={error}
      submitLabel={t("settings.create")}
      pendingLabel={t("settings.creating")}
      onSubmit={(form) => {
        setError(null);
        const value = String(form.get("value") ?? "");
        create.mutate({
          id: String(form.get("id")).trim(),
          url: String(form.get("url")).trim(),
          branch: String(form.get("branch")).trim(),
          auth:
            auth === "basic"
              ? {
                  kind: "basic",
                  username: String(form.get("username")).trim(),
                  value,
                }
              : auth === "bearer"
                ? { kind: "bearer", value }
                : { kind: "none" },
        });
      }}
    >
      <Field>
        <FieldLabel>{t("settings.id")}</FieldLabel>
        <Input
          name="id"
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field>
        <FieldLabel>{t("settings.repos.url")}</FieldLabel>
        <Input
          name="url"
          type="url"
          required
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field>
        <FieldLabel>{t("settings.repos.branch")}</FieldLabel>
        <Input
          name="branch"
          required
          defaultValue="main"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field>
        <FieldLabel>{t("settings.repos.auth")}</FieldLabel>
        <NativeSelect
          name="auth"
          value={auth}
          onChange={(event) => {
            const next = event.target.value;
            setAuth(next === "basic" || next === "bearer" ? next : "none");
          }}
        >
          <NativeSelectOption value="none">
            {t("settings.repos.auth.none")}
          </NativeSelectOption>
          <NativeSelectOption value="bearer">
            {t("settings.repos.auth.bearer")}
          </NativeSelectOption>
          <NativeSelectOption value="basic">
            {t("settings.repos.auth.basic")}
          </NativeSelectOption>
        </NativeSelect>
      </Field>
      {auth === "basic" ? (
        <Field>
          <FieldLabel>{t("settings.repos.username")}</FieldLabel>
          <Input
            name="username"
            required
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ) : null}
      {auth === "none" ? null : (
        <SecretInput label={t("settings.repos.token")} />
      )}
    </FormDialog>
  );
}

function EditBranch({
  repository,
  onClose,
  onOutcome,
}: {
  readonly repository: SettingsRepository | null;
  readonly onClose: () => void;
  readonly onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const save = useSettingsWrite(
    "repository",
    (client, input: { id: string; branch: string }) =>
      unwrap(
        client.PATCH("/v1/installation/settings/repositories/{id}", {
          params: { path: { id: input.id } },
          body: { branch: input.branch },
        }),
      ),
    {
      onDone: (answer) => {
        onClose();
        onOutcome({
          kind: "notice",
          text: t("settings.done.changed", { id: answer.id }),
        });
      },
      onRefused: setError,
    },
  );
  return (
    <FormDialog
      open={repository !== null}
      onOpenChange={(open) => {
        setError(null);
        if (!open) onClose();
      }}
      pending={save.isPending}
      title={t("settings.repos.editBranchTitle", { id: repository?.id ?? "" })}
      description={t("settings.repos.editBranchDescription")}
      error={error}
      submitLabel={t("settings.save")}
      pendingLabel={t("settings.saving")}
      onSubmit={(form) => {
        if (repository === null) return;
        setError(null);
        save.mutate({
          id: repository.id,
          branch: String(form.get("branch")).trim(),
        });
      }}
    >
      <Field>
        <FieldLabel>{t("settings.repos.branch")}</FieldLabel>
        <Input
          name="branch"
          required
          autoComplete="off"
          spellCheck={false}
          defaultValue={repository?.branch ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
