import { Search } from "lucide-react";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { Input } from "./input.tsx";

/*
 * Console v4 `.toolbar .grow`: a search field that shares a toolbar row. In a
 * flex row it starts at 160px and grows to 320px, never under 140px. The
 * placeholder disappears once someone types, so the name is a required
 * `aria-label` (the placeholder's words, as in v4).
 */
export type SearchInputProps = Omit<ComponentProps<"input">, "aria-label"> & {
  readonly "aria-label": string;
  /** Classes for the wrapper, which carries the flex sizing and the icon. */
  readonly wrapperClassName?: string | undefined;
};

export function SearchInput({
  className,
  wrapperClassName,
  ...props
}: SearchInputProps): JSX.Element {
  return (
    <div
      data-slot="search-input"
      className={cn(
        "relative min-w-[140px] max-w-[320px] flex-[1_1_160px]",
        wrapperClassName,
      )}
    >
      <Search
        data-slot="search-input-icon"
        aria-hidden="true"
        strokeWidth={1.5}
        className="pointer-events-none absolute top-2 left-2.5 size-4 text-subtle-foreground"
      />
      <Input className={cn("border-border pl-8", className)} {...props} />
    </div>
  );
}
