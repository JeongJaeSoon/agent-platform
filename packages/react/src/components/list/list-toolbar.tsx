import { cn, SearchInput, type SearchInputProps } from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

export interface ListToolbarProps {
  /** The list's categories on the left, usually a SegmentedControl with counts. */
  readonly filter: ReactNode;
  /** The search field, first on the right. */
  readonly search?: SearchInputProps | undefined;
  /** How the list is drawn (cards or table), after the search. */
  readonly view?: ReactNode;
  readonly className?: string | undefined;
}

/*
 * The list toolbar of the session and agent lists: categories on the left,
 * search then view on the right (Vercel's order). The search keeps a fixed
 * 260px beside the categories; below `sm` the right group takes its own
 * full-width row and the search fills what the view switch leaves.
 */
export function ListToolbar({
  filter,
  search,
  view,
  className,
}: ListToolbarProps): JSX.Element {
  return (
    <div
      data-slot="list-toolbar"
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        className,
      )}
    >
      {filter}
      {search || view ? (
        <div
          data-slot="list-toolbar-end"
          className="ml-auto flex w-full items-center gap-2 sm:w-auto"
        >
          {search ? (
            <SearchInput
              {...search}
              wrapperClassName={cn(
                "max-w-none sm:w-[260px] sm:flex-none",
                search.wrapperClassName,
              )}
            />
          ) : null}
          {view}
        </div>
      ) : null}
    </div>
  );
}
