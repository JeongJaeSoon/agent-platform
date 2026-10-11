import type { ReactNode } from "react";

export const MAIN_CONTENT_ID = "main";

export function Main({
  className,
  children,
}: {
  readonly className: string;
  readonly children: ReactNode;
}) {
  return (
    <main id={MAIN_CONTENT_ID} className={className} tabIndex={-1}>
      {children}
    </main>
  );
}
