import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { TeamChangeResponse } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Button,
  buttonVariants,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  FieldLabel,
  Input,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { queryKeys } from "../api/queries.ts";
import { ReasonButton, refusalText, useRole } from "../auth/guard.tsx";
import { useI18n } from "../i18n/i18n.tsx";

/** The 팀 tab's head button: a team's name in a dialog, then the new team. */
export function TeamCreateDialog({
  reason,
  onCreated,
}: {
  readonly reason: string | undefined;
  readonly onCreated: (name: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* As the trigger, the button gets the focus back when the dialog closes. */}
      <DialogTrigger asChild>
        <ReasonButton
          type="button"
          className={buttonVariants()}
          reason={reason}
        >
          <Plus aria-hidden="true" />
          {t("teams.create")}
        </ReasonButton>
      </DialogTrigger>
      <DialogContent>
        <TeamCreateForm
          onCreated={(name) => {
            setOpen(false);
            onCreated(name);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

// Mounted while the dialog is open, so each opening starts empty.
function TeamCreateForm({
  onCreated,
}: {
  readonly onCreated: (name: string) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation<TeamChangeResponse, ApiError, string>({
    mutationFn: (body) =>
      unwrap(client.POST("/v1/teams", { body: { name: body } })),
    onMutate: () => setError(null),
    onSuccess: async ({ team }) => {
      onCreated(team.name);
      await queryClient.invalidateQueries({ queryKey: queryKeys.teams });
    },
    onError: (failure) =>
      setError(
        failure.code === "ALREADY_EXISTS"
          ? t("teams.nameTaken")
          : refusalText(t, failure, "team.manage", role),
      ),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!create.isPending) create.mutate(name.trim());
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{t("teams.create")}</DialogTitle>
        <DialogDescription>{t("teams.createDescription")}</DialogDescription>
      </DialogHeader>
      {error === null ? null : (
        <Alert variant="red" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel>{t("teams.name")}</FieldLabel>
        <Input
          name="team-name"
          required
          maxLength={100}
          autoComplete="off"
          value={name}
          readOnly={create.isPending}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t("common.cancel")}
          </Button>
        </DialogClose>
        {/* aria-disabled, not disabled: Enter on it keeps the focus there. */}
        <Button
          type="submit"
          className="aria-disabled:opacity-50"
          aria-disabled={create.isPending || undefined}
        >
          {create.isPending ? t("teams.creating") : t("teams.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
