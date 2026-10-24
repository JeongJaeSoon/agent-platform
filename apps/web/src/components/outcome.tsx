import { Notice } from "./auth-page.tsx";

/** What the last action on a screen came to, shown above its content. */
export type Outcome =
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

export function OutcomeLine({ outcome }: { readonly outcome: Outcome | null }) {
  if (!outcome) return null;
  return outcome.kind === "error" ? (
    <p className="web-form__error" role="alert">
      {outcome.text}
    </p>
  ) : (
    <Notice>{outcome.text}</Notice>
  );
}
