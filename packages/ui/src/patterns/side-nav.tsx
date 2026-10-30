import { ChevronDown } from "lucide-react";
import {
  type ComponentProps,
  isValidElement,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { cn } from "../foundations/cn.ts";
import { Button } from "../primitives/button.tsx";

/*
 * A list of the pages or sections inside one screen, on its left: settings
 * pages, or the sections of a long agent setting. Use it when there are four
 * or more siblings and people stay a while; two or three are LinkTabs, panels
 * switched in place are Tabs. Below lg the list folds behind one button above
 * the page that names where you are: from md the app's sidebar already takes
 * the left, and both beside the page leave it too narrow. It lays out a page,
 * not a dialog: a Radix dialog takes Escape before the folded list can.
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
        "flex w-full flex-col gap-6 lg:flex-row lg:gap-8",
        className,
      )}
      {...props}
    >
      {nav}
      {/* Runs to the page frame's edge like every other page. */}
      <div className="min-w-0 flex-1">{children}</div>
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
   * Called when a link picked from the unfolded list folds it away, after the
   * link's onClick. Move focus to what the link opened here; otherwise it
   * stays on the button.
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
  const picking = useRef(false);
  const fold = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  // Folds before the link's own onClick, which may scroll to a section below
  // the list and must measure the page without it.
  const pick = (event: MouseEvent<HTMLDivElement>) => {
    picking.current = open && !!(event.target as Element).closest("a");
    if (!picking.current) return;
    flushSync(() => setOpen(false));
    // Where the link scrolls stays: the button may be above the screen then.
    toggle.current?.focus({ preventScroll: true });
  };
  // Bubbles up after the link's own onClick; a link that stops the click
  // keeps focus on the button and gets no onPick.
  const picked = () => {
    if (!picking.current) return;
    picking.current = false;
    onPick?.();
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open || event.key !== "Escape" || event.defaultPrevented) return;
    // Folding the list is all this Escape does; handlers above it in the page
    // do not see it.
    event.preventDefault();
    event.stopPropagation();
    fold();
  };
  return (
    <nav
      data-slot="side-nav"
      aria-label={label}
      className={cn(
        "lg:sticky lg:top-4 lg:w-55 lg:flex-none lg:self-start",
        className,
      )}
      {...props}
    >
      <Button
        ref={toggle}
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-between lg:hidden"
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the handlers only watch clicks and keys from the links inside */}
      <div
        id={listId}
        className={cn(
          open ? "mt-2 flex rounded-card border p-2" : "hidden",
          "flex-col gap-3 lg:mt-0 lg:flex lg:border-0 lg:p-0",
        )}
        onClickCapture={pick}
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
          className="m-0 px-3 text-caption text-subtle-foreground"
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
   * section scrolled to on one page. The caller decides. A router link sets
   * its own `aria-current="page"` once active, over this value: give it exact
   * matching, and make "location" items plain `#section` anchors.
   */
  readonly current?: boolean | "page" | "location" | undefined;
  /** Render the single child (a router link) as the item. */
  readonly asChild?: boolean | undefined;
};

export function SideNavLink({
  current = false,
  asChild = false,
  className,
  children,
  ...props
}: SideNavLinkProps): JSX.Element {
  return (
    <Button
      asChild
      variant={current ? "secondary" : "ghost"}
      className={cn("w-full justify-start", className)}
      data-slot="side-nav-link"
      aria-current={current === true ? "page" : current || undefined}
      // Button's Slot merges these into the link: both onClicks run, both
      // classNames stay.
      {...(props as ComponentProps<typeof Button>)}
    >
      {asChild && isValidElement(children) ? (
        children
      ) : (
        <a href={props.href}>{children}</a>
      )}
    </Button>
  );
}
