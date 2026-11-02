import { FormError, Notice } from "./auth-page.tsx";

/** What the last action on a screen came to, shown above its content. */
export type Outcome =
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

export function OutcomeLine({
  outcome,
  live = false,
}: {
  readonly outcome: Outcome | null;
  /**
   * Keep the notice region mounted while there is no notice, so a screen
   * reader hears one that arrives later.
   */
  readonly live?: boolean;
}) {
  const error = outcome?.kind === "error" ? outcome.text : null;
  const notice = outcome?.kind === "notice" ? outcome.text : null;
  return (
    <>
      {error === null ? null : <FormError>{error}</FormError>}
      {notice !== null || live ? <Notice>{notice}</Notice> : null}
    </>
  );
}
