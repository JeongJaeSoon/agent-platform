import { Alert, Card } from "@werft-ai/ui";
import type { ReactNode } from "react";
import { Main } from "./main.tsx";

/**
 * Title and card as one block. The auth-page class is how RootLayout knows
 * to centre it in the viewport.
 */
export function AuthPage({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Main className="auth-page px-4 py-8">
      <div className="mx-auto flex w-full max-w-[25rem] flex-col gap-6">
        <h1 className="m-0 text-center font-semibold text-title">{title}</h1>
        <Card className="gap-4 px-4">{children}</Card>
      </div>
    </Main>
  );
}

export function FormError({ children }: { readonly children: ReactNode }) {
  return (
    <p className="m-0 text-destructive" role="alert">
      {children}
    </p>
  );
}

export const ASIDE = "m-0 text-muted-foreground text-sm";

/**
 * What an action came to, as a live region. Without children it stays
 * mounted but out of sight, so text put in later is still read out.
 */
export function Notice({ children }: { readonly children?: ReactNode }) {
  const shown = children !== null && children !== undefined && children !== "";
  return (
    <Alert
      asChild
      variant="blue"
      icon={shown ? undefined : null}
      className={shown ? undefined : "sr-only"}
    >
      <output>{children}</output>
    </Alert>
  );
}
