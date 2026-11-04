import { ArrowRight } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  type JSX,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "../foundations/cn.ts";
import { Link, type LinkProps, withTrailing } from "../primitives/link.tsx";

type MoreLinkShape =
  | {
      /** `caption`: 12px on a section title's line, as on the operations tabs. */
      readonly size?: "caption" | undefined;
      readonly arrow?: undefined;
    }
  | {
      /** `control`: 13px, as on the home and agent overview sections. */
      readonly size: "control";
      /** A trailing 14px arrow, kept on the text's line. */
      readonly arrow?: boolean | undefined;
    };

export type MoreLinkProps = LinkProps & MoreLinkShape;

/**
 * A section's "view all" link to the page or tab that says more. A router
 * link goes in with `asChild`; the arrow is drawn inside it.
 */
export function MoreLink({
  size = "caption",
  arrow = false,
  className,
  asChild = false,
  children,
  ...props
}: MoreLinkProps): JSX.Element {
  const icon = arrow ? (
    <ArrowRight className="size-3.5" aria-hidden="true" />
  ) : null;
  // A router link's children may be a function of its state.
  const content = !icon
    ? children
    : asChild && isValidElement<{ children?: unknown }>(children)
      ? cloneElement(
          children as ReactElement<{ children?: unknown }>,
          undefined,
          withTrailing(children.props.children, icon) as ReactNode,
        )
      : (withTrailing(children, icon) as ReactNode);
  return (
    <Link
      {...props}
      asChild={asChild}
      className={cn(
        size === "caption"
          ? "whitespace-nowrap font-normal text-caption leading-4"
          : arrow
            ? "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-(color:--werft-color-link) text-control"
            : "text-control",
        className,
      )}
    >
      {content}
    </Link>
  );
}
