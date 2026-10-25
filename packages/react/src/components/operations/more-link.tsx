import { cn, Link, type LinkProps } from "@werft-ai/ui";
import type { JSX } from "react";

/**
 * A section's link to the tab that says more, such as "도구 활동": caption
 * size on the section title's line. A router link goes in with `asChild`.
 */
export function MoreLink({ className, ...props }: LinkProps): JSX.Element {
  return (
    <Link
      {...props}
      className={cn(
        "whitespace-nowrap font-normal text-caption leading-4",
        className,
      )}
    />
  );
}
