import { ChevronDown } from "lucide-react";
import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";
import { Button } from "../primitives/button.tsx";

/*
 * A list of the pages or sections inside one screen, on its left: settings
 * pages, or the sections of a long agent setting. Use it when there are four
 * or more siblings and people stay a while; two or three are LinkTabs, panels
 * switched in place are Tabs. Below md the list folds behind one button above
 * the page that names where you are.
 */

export type SideNavLayoutProps = Omit<ComponentProps<"div">, "children"> & {
  /** A `SideNav`. */
  readonly nav: ReactNode;
  readonly children: ReactNode;
};

export function SideNavLayout({
  nav,
  children,
  className,
  ...props
}: SideNavLayoutProps): JSX.Element {
  return (
    <div
      data-slot="side-nav-layout"
      className={cn(
        "flex w-full flex-col gap-6 md:flex-row md:gap-8",
        className,
      )}
      {...props}
    >
      {nav}
      <div className="min-w-0 max-w-180 flex-1">{children}</div>
    </div>
  );
}

export type SideNavProps = Omit<
  ComponentProps<"nav">,
  "aria-label" | "children"
> & {
  /** Names the list, e.g. "설정"; the folded button starts with it. */
  readonly "aria-label": string;
  /** The current item's label, shown on the folded button after the name. */
  readonly current?: ReactNode | undefined;
  /**
   * Called when a link picked from the unfolded list folds it away. Move focus
   * to what the link opened here; otherwise it returns to the button.
   */
  readonly onPick?: (() => void) | undefined;
  readonly children: ReactNode;
};

export function SideNav({
  "aria-label": label,
  current,
  onPick,
  className,
  children,
  ...props
}: SideNavProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const fold = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  // Bubbles up after the link's own onClick, which is never stopped here.
  const picked = (event: MouseEvent<HTMLDivElement>) => {
    if (!open || !(event.target as Element).closest("a")) return;
    fold();
    onPick?.();
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    fold();
  };
  return (
    <nav
      data-slot="side-nav"
      aria-label={label}
      className={cn(
        "md:sticky md:top-4 md:w-55 md:flex-none md:self-start",
        className,
      )}
      {...props}
    >
      <Button
        ref={toggle}
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-between md:hidden"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 truncate">
          {label}
          {current ? (
            <>
              <span className="text-muted-foreground"> · </span>
              {current}
            </>
          ) : null}
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
      </Button>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the handlers only watch what bubbles from the links inside */}
      <div
        id={listId}
        className={cn(
          open ? "mt-2 flex rounded-card border p-2" : "hidden",
          "flex-col gap-4 md:mt-0 md:flex md:border-0 md:p-0",
        )}
        onClick={picked}
        onKeyDown={closeOnEscape}
      >
        {children}
      </div>
    </nav>
  );
}

export type SideNavGroupProps = Omit<ComponentProps<"div">, "children"> & {
  /** The group's heading; leave it out when the list has one group. */
  readonly label?: ReactNode | undefined;
  readonly children: ReactNode;
};

export function SideNavGroup({
  label,
  className,
  children,
  ...props
}: SideNavGroupProps): JSX.Element {
  const headingId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls, these are links
    <div
      role="group"
      aria-labelledby={label ? headingId : undefined}
      className={cn("flex flex-col gap-1", className)}
      {...props}
    >
      {label ? (
        <p
          id={headingId}
          className="m-0 px-3 text-caption text-muted-foreground"
        >
          {label}
        </p>
      ) : null}
      {children}
    </div>
  );
}

export type SideNavLinkProps = ComponentProps<"a"> & {
  /**
   * Where you are: `true` or "page" for the page shown, "location" for the
   * section scrolled to on one page. The caller decides; a router link that
   * sets its own `aria-current` (TanStack does for a parent path) needs exact
   * matching.
   */
  readonly current?: boolean | "page" | "location" | undefined;
  /** Render the single child (a router link) as the item. */
  readonly asChild?: boolean | undefined;
};

export function SideNavLink({
  current = false,
  asChild = false,
  children,
  ...props
}: SideNavLinkProps): JSX.Element {
  return (
    <Button
      asChild
      variant={current ? "secondary" : "ghost"}
      className="w-full justify-start"
      data-slot="side-nav-link"
      aria-current={current === true ? "page" : current || undefined}
    >
      {asChild && isValidElement(children) ? (
        cloneElement(children, props)
      ) : (
        <a {...props}>{children}</a>
      )}
    </Button>
  );
}
