import { Card } from "@werft-ai/ui";
import type { ReactNode } from "react";
import { Main } from "./main.tsx";

/** Title and card as one block; RootLayout centres it in the viewport. */
export function AuthPage({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Main className="min-w-0 px-4 py-8">
      <div className="mx-auto flex w-full max-w-[25rem] flex-col gap-6">
        <h1 className="m-0 text-center font-semibold text-xl">{title}</h1>
        <Card className="gap-4 px-4">{children}</Card>
      </div>
    </Main>
  );
}

export const LINK = "text-primary underline underline-offset-2";

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
