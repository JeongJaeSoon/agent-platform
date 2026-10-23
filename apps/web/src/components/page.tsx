import { PageHeader, type PageHeaderProps } from "@werft-ai/ui";
import type { ReactNode } from "react";

/** A console page: its header, then its sections 32px apart (console v35). */
export function Page({
  children,
  ...header
}: Omit<PageHeaderProps, "className"> & { readonly children?: ReactNode }) {
  return (
    <div className="flex flex-col">
      <PageHeader {...header} />
      <div className="flex flex-col gap-[var(--ap-space-section)]">
        {children}
      </div>
    </div>
  );
}
