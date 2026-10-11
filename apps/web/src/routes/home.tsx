import { useId } from "react";
import { useMe } from "../auth/guard.tsx";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";

/**
 * The bootstrap checklist. Only the first step is known to be done here; the
 * rest are placeholders the invite, agent and session screens (94S-460, I1)
 * replace with their own state.
 */
const CHECKLIST: readonly { key: MessageKey; done: boolean }[] = [
  { key: "home.checklist.admin", done: true },
  { key: "home.checklist.invite", done: false },
  { key: "home.checklist.agent", done: false },
  { key: "home.checklist.session", done: false },
];

export function HomeScreen() {
  const { t } = useI18n();
  const me = useMe();
  const checklistTitle = useId();
  return (
    <div className="web-home">
      <h1 className="web-home__title">
        {me?.workspace?.name ?? t("home.title")}
      </h1>
      {me?.user ? (
        <p className="web-home__who">
          {t("home.signedInAs", {
            name: me.user.display_name,
            email: me.user.email,
          })}
        </p>
      ) : null}
      <section className="web-checklist" aria-labelledby={checklistTitle}>
        <h2 id={checklistTitle}>{t("home.checklist.title")}</h2>
        <ol>
          {CHECKLIST.map((step) => (
            <li
              key={step.key}
              className="web-checklist__step"
              data-done={step.done}
            >
              <span className="web-checklist__mark" aria-hidden="true">
                {step.done ? "✓" : "○"}
              </span>
              <span>{t(step.key)}</span>
              <span className="web-checklist__state">
                {step.done ? t("common.done") : t("common.pending")}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
