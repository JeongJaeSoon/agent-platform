import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { ArrowRight } from "lucide-react";
import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  type JSX,
  type ReactNode,
} from "react";

import { cn } from "../foundations/cn.ts";

// The focus outline apps/web draws on every focusable element, kept on the
// part so a host without that global rule still shows it. No `outline-none`:
// Tailwind 4 carries its `none` into `outline-2`.
const FOCUS_OUTLINE =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

/*
 * Console v35 links: `hover` is the standalone link (a name in a list, a
 * "view all"), `always` the link inside a sentence, which keeps the text's
 * weight. `variant="table"` is a row's name link: no underline until hover,
 * and it underlines on keyboard focus too. `variant="more"` is a section's
 * "view all": 13px with a trailing 14px arrow (console v4 `.link` L207, L534).
 */
export const linkVariants = cva(
  `text-link underline-offset-2 ${FOCUS_OUTLINE}`,
  {
    variants: {
      underline: {
        hover: "font-medium hover:underline",
        always: "underline",
      },
      variant: {
        default: "",
        table:
          "font-medium no-underline hover:underline focus-visible:underline",
        more: "inline-flex items-center gap-1 font-medium text-control",
      },
    },
    defaultVariants: { underline: "hover", variant: "default" },
  },
);

// A router link's children may be a function of its state.
type ChildProps = Pick<ComponentProps<"a">, "rel" | "target"> & {
  readonly children?: unknown;
};

export type LinkProps = ComponentProps<"a"> &
  VariantProps<typeof linkVariants> & {
    /**
     * Render the single child (a router link) with the link's look. A rel the
     * router adds later, such as TanStack's `activeProps`, is out of reach.
     */
    readonly asChild?: boolean;
    /**
     * Screen-reader text appended when the link opens a new tab, e.g.
     * "(새 탭에서 열림)". The caller translates it.
     */
    readonly newTabLabel?: ReactNode;
  };

// A new tab must not get `window.opener` or the referrer, whatever rel the
// caller passed.
function safeRel(newTab: boolean, ...rels: (string | undefined)[]) {
  const tokens = new Set(rels.join(" ").split(/\s+/).filter(Boolean));
  if (newTab) {
    tokens.add("noopener");
    tokens.add("noreferrer");
  }
  return tokens.size > 0 ? [...tokens].join(" ") : undefined;
}

function withTrailing(children: unknown, trailing: ReactNode): unknown {
  if (typeof children !== "function") {
    return (
      <>
        {children as ReactNode}
        {trailing}
      </>
    );
  }
  return (...args: unknown[]) => (
    <>
      {children(...args)}
      {trailing}
    </>
  );
}

export function Link({
  className,
  underline,
  variant,
  asChild = false,
  newTabLabel,
  children,
  ...props
}: LinkProps): JSX.Element {
  // Slot lets the child's own target and rel win, and would turn a router
  // link's function children into an array, so the child is rewritten here
  // and handed to Slot whole.
  const child =
    asChild && isValidElement<ChildProps>(children) ? children : null;
  // Browsers match the target keyword without case.
  const newTab =
    (child?.props.target ?? props.target)?.toLowerCase() === "_blank";
  const rel = safeRel(newTab, props.rel, child?.props.rel);
  const arrow =
    variant === "more" ? (
      <ArrowRight
        aria-hidden="true"
        className="size-3.5 shrink-0"
        strokeWidth={1.5}
      />
    ) : null;
  const label =
    newTab && newTabLabel != null ? (
      <span className="sr-only">{newTabLabel}</span>
    ) : null;
  const trailing =
    arrow || label ? (
      <>
        {arrow}
        {label}
      </>
    ) : null;
  const shared = {
    "data-slot": "link",
    className: cn(linkVariants({ underline, variant }), className),
    ...props,
    rel,
  };
  if (child) {
    return (
      <Slot {...shared}>
        {cloneElement(
          child,
          trailing
            ? { rel, children: withTrailing(child.props.children, trailing) }
            : { rel },
        )}
      </Slot>
    );
  }
  return (
    <a {...shared}>
      {children}
      {trailing}
    </a>
  );
}

export type SkipLinkProps = ComponentProps<"a"> & {
  /** The id of the main content, as `#main`; it needs `tabIndex={-1}`. */
  readonly href: string;
};

function fragmentId(href: string): string {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}

/*
 * "Skip to content": off screen until it takes focus, so the first Tab lands
 * on it. Its positioned ancestor is the page root.
 */
export function SkipLink({
  className,
  href,
  onClick,
  ...props
}: SkipLinkProps): JSX.Element {
  return (
    <a
      data-slot="skip-link"
      className={cn(
        `absolute top-2 left-2 z-50 -translate-y-[200%] rounded-control bg-card px-3 py-2 focus:translate-y-0 ${FOCUS_OUTLINE}`,
        className,
      )}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !href.startsWith("#")) return;
        // A fragment jump alone does not move focus in every browser, and an
        // untrusted click (a script, a test) never does.
        const target = document.getElementById(fragmentId(href));
        if (target === null) return;
        event.preventDefault();
        target.focus();
      }}
      {...props}
    />
  );
}
