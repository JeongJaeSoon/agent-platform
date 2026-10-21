import type { ReactNode } from "react";
import { Main } from "./main.tsx";

/** The narrow single-column page every signed-out screen sits in. */
export function AuthPage({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-6 md:px-6 md:py-10">
      <h1 className="m-0 font-semibold text-xl">{title}</h1>
      {children}
    </Main>
  );
}

export const LINK = "text-primary underline underline-offset-2";

/** A form-level message: what the server refused, read out as it appears. */
export function FormError({ children }: { readonly children: ReactNode }) {
  return (
    <p className="m-0 text-destructive" role="alert">
      {children}
    </p>
  );
}

export const ASIDE = "m-0 text-muted-foreground text-sm";

export const NOTICE =
  "m-0 block rounded-md border border-[var(--ap-tone-progress-border)] bg-[var(--ap-tone-progress-bg)] p-3 text-[var(--ap-tone-progress-fg)]";
