import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
} from "@werft-ai/ui";
import { type FormEvent, useState } from "react";
import { PASSWORD_MIN_LENGTH } from "../auth/limits.ts";
import { ASIDE, AuthPage, FormError, LINK } from "../components/auth-page.tsx";
import { slugInput } from "../components/field.tsx";
import { errorKey, type MessageKey, useI18n } from "../i18n/i18n.tsx";

const FIELDS = [
  {
    name: "bootstrap_token",
    label: "bootstrap.token",
    type: "password",
    autoComplete: "off",
  },
  {
    name: "email",
    label: "bootstrap.email",
    type: "email",
    autoComplete: "username",
  },
  {
    name: "display_name",
    label: "bootstrap.displayName",
    type: "text",
    autoComplete: "name",
  },
  {
    name: "password",
    label: "bootstrap.password",
    type: "password",
    autoComplete: "new-password",
  },
  {
    name: "workspace_name",
    label: "bootstrap.workspaceName",
    type: "text",
    autoComplete: "organization",
  },
  {
    name: "workspace_slug",
    label: "bootstrap.workspaceSlug",
    type: "text",
    autoComplete: "off",
  },
] as const satisfies readonly {
  name: string;
  label: MessageKey;
  type: string;
  autoComplete: string;
}[];

type FieldName = (typeof FIELDS)[number]["name"];
type Form = Record<FieldName, string>;

const EMPTY: Form = {
  bootstrap_token: "",
  email: "",
  display_name: "",
  password: "",
  workspace_name: "",
  workspace_slug: "",
};

// No public read says whether bootstrap is done, so this screen learns it
// from the answer: 409 BOOTSTRAP_DONE sends the reader to log in.
export function BootstrapScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(EMPTY);

  const create = useMutation<unknown, ApiError>({
    meta: { public: true },
    mutationFn: () => unwrap(client.POST("/v1/auth/bootstrap", { body: form })),
    onSuccess: () =>
      navigate({
        to: "/login",
        search: { notice: "created" },
        // History state, not the URL: the address stays free of the email.
        state: (prev) => ({ ...prev, loginEmail: form.email }),
      }),
    onError: async (error) => {
      if (error.code === "BOOTSTRAP_DONE") {
        await navigate({ to: "/login", search: { notice: "bootstrap_done" } });
      }
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  const errorText = create.error
    ? create.error.status === 401
      ? t("bootstrap.tokenInvalid")
      : t(errorKey(create.error.code))
    : null;

  return (
    <AuthPage title={t("bootstrap.title")}>
      <p className={ASIDE}>{t("bootstrap.intro")}</p>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {FIELDS.map((field) => {
          const hint =
            field.name === "password"
              ? t("bootstrap.passwordHint", { min: PASSWORD_MIN_LENGTH })
              : field.name === "workspace_slug"
                ? t("bootstrap.workspaceSlugHint")
                : null;
          return (
            <Field key={field.name}>
              <FieldLabel>{t(field.label)}</FieldLabel>
              <Input
                name={field.name}
                type={field.type}
                autoComplete={field.autoComplete}
                required
                {...(field.name === "password"
                  ? { minLength: PASSWORD_MIN_LENGTH }
                  : {})}
                {...(field.name === "workspace_slug"
                  ? slugInput(t("field.slugFormat"))
                  : {})}
                value={form[field.name]}
                onChange={(event) =>
                  setForm({ ...form, [field.name]: event.target.value })
                }
              />
              {hint ? <FieldDescription>{hint}</FieldDescription> : null}
            </Field>
          );
        })}
        {errorText ? <FormError>{errorText}</FormError> : null}
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t("bootstrap.submitting") : t("bootstrap.submit")}
        </Button>
      </form>
      <p className={ASIDE}>
        <Link className={LINK} to="/login">
          {t("bootstrap.loginLink")}
        </Link>
      </p>
    </AuthPage>
  );
}
