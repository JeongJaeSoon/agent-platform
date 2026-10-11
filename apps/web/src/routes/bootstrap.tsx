import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { type ApiError, unwrap } from "../api/client.ts";
import { PASSWORD_MIN_LENGTH } from "../auth/limits.ts";
import { Main } from "../components/main.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type MessageKey, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

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
  const { client } = useServices();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(EMPTY);
  const hintId = useId();

  const create = useMutation<unknown, ApiError>({
    meta: { public: true },
    mutationFn: () => unwrap(client.POST("/v1/auth/bootstrap", { body: form })),
    onSuccess: () => navigate({ to: "/login", search: { notice: "created" } }),
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
    <Main className="web-auth">
      <h1 className="web-auth__title">{t("bootstrap.title")}</h1>
      <StatusScreen kind="bootstrap-required" action={false} />
      <p className="web-auth__intro">{t("bootstrap.intro")}</p>
      <form className="web-form" onSubmit={submit}>
        {FIELDS.map((field) => {
          const hint =
            field.name === "password"
              ? t("bootstrap.passwordHint", { min: PASSWORD_MIN_LENGTH })
              : field.name === "workspace_slug"
                ? t("bootstrap.workspaceSlugHint")
                : null;
          const describedBy = `${hintId}-${field.name}`;
          return (
            <div className="web-field" key={field.name}>
              <label className="web-field">
                <span>{t(field.label)}</span>
                <input
                  className="ap-input"
                  name={field.name}
                  type={field.type}
                  autoComplete={field.autoComplete}
                  required
                  {...(hint ? { "aria-describedby": describedBy } : {})}
                  {...(field.name === "password"
                    ? { minLength: PASSWORD_MIN_LENGTH }
                    : {})}
                  {...(field.name === "workspace_slug"
                    ? { pattern: "[a-z0-9][a-z0-9\\-]*", maxLength: 64 }
                    : {})}
                  value={form[field.name]}
                  onChange={(event) =>
                    setForm({ ...form, [field.name]: event.target.value })
                  }
                />
              </label>
              {hint ? (
                <small id={describedBy} className="web-field__hint">
                  {hint}
                </small>
              ) : null}
            </div>
          );
        })}
        {errorText ? (
          <p className="web-form__error" role="alert">
            {errorText}
          </p>
        ) : null}
        <button
          type="submit"
          className="ap-button ap-button--primary"
          disabled={create.isPending}
        >
          {create.isPending ? t("bootstrap.submitting") : t("bootstrap.submit")}
        </button>
      </form>
      <p className="web-auth__aside">
        <Link to="/login">{t("bootstrap.loginLink")}</Link>
      </p>
    </Main>
  );
}
