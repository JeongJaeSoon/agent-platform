import {
  Field,
  FieldContent,
  FieldLabel,
  Page,
  RadioGroup,
  RadioGroupItem,
} from "@werft-ai/ui";
import { type ReactNode, useId } from "react";
import { roleLabel, useMe, useRole } from "../auth/guard.tsx";
import { chooseTheme, type Theme, useTheme } from "../components/theme.ts";
import {
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  type MessageKey,
  useI18n,
} from "../i18n/i18n.tsx";

const CARD = "flex flex-col gap-3 rounded-card border bg-card p-4";
const CARD_TITLE = "m-0 font-semibold text-body";
const HINT = "m-0 text-control text-muted-foreground";
const THEME_ORDER: readonly Theme[] = ["light", "dark", "system"];

/**
 * How the console looks to the caller. The theme stays in this browser; the
 * language is also saved on the server (useSavedLocale), for Slack.
 */
export function PreferencesScreen() {
  const { t, locale, setLocale } = useI18n();
  const theme = useTheme();
  return (
    <Page title={t("nav.preferences")} description={t("preferences.lead")}>
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        <ChoiceCard
          title={t("common.language")}
          hint={t("preferences.languageHint")}
          value={locale}
          onChange={(value) => setLocale(value as Locale)}
          options={LOCALES.map((value) => ({
            value,
            // Each language in its own words, whatever the page shows now.
            label: <span lang={value}>{LOCALE_NAMES[value]}</span>,
            note: t(`preferences.languageNote.${value}`),
          }))}
        />
        <ChoiceCard
          title={t("shell.theme")}
          hint={t("preferences.themeHint")}
          value={theme}
          onChange={(value) => chooseTheme(value as Theme)}
          options={THEME_ORDER.map((value) => ({
            value,
            label: t(`shell.theme.${value}`),
            note: t(`preferences.themeNote.${value}`),
          }))}
        />
        <AccountCard />
      </div>
    </Page>
  );
}

function ChoiceCard({
  title,
  hint,
  value,
  onChange,
  options,
}: {
  readonly title: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly {
    readonly value: string;
    readonly label: ReactNode;
    readonly note: string;
  }[];
}) {
  const titleId = useId();
  const hintId = useId();
  return (
    <section aria-labelledby={titleId} className={`${CARD} @container`}>
      <h2 id={titleId} className={CARD_TITLE}>
        {title}
      </h2>
      <p id={hintId} className={HINT}>
        {hint}
      </p>
      <RadioGroup
        aria-labelledby={titleId}
        aria-describedby={hintId}
        value={value}
        onValueChange={onChange}
        className="gap-2 @[560px]:grid-cols-3"
      >
        {options.map((option) => (
          <FieldLabel key={option.value}>
            <Field orientation="horizontal" className="items-start">
              <RadioGroupItem value={option.value} />
              <FieldContent className="gap-1">
                <span className="font-semibold">{option.label}</span>
                <span className="font-normal text-caption text-muted-foreground">
                  {option.note}
                </span>
              </FieldContent>
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
    </section>
  );
}

function AccountCard() {
  const { t } = useI18n();
  const me = useMe();
  const role = useRole();
  const titleId = useId();
  const rows: readonly [MessageKey, string | undefined][] = [
    ["preferences.name", me?.user?.display_name],
    ["preferences.email", me?.user?.email],
    ["preferences.role", role ? roleLabel(t, role) : undefined],
    ["preferences.workspace", me?.workspace?.name],
  ];
  return (
    <section aria-labelledby={titleId} className={CARD}>
      <h2 id={titleId} className={CARD_TITLE}>
        {t("preferences.account")}
      </h2>
      <dl className="m-0 grid grid-cols-[minmax(0,8.75rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-body">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{t(label)}</dt>
            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
              {value ?? t("sessions.none")}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
