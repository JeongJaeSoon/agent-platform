import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

// Mockup v4's names. Its "body" is 13px, which is Tailwind's `text-control`
// here: the `text-body` key is v4's 14px section size.
const TEXT_VARIANT = {
  // `.app`: 13px on a 20px line.
  body: { size: "text-control", leading: "leading-5", tone: "text-foreground" },
  // `.sub` and `.page-desc`.
  sub: {
    size: "text-control",
    leading: "leading-5",
    tone: "text-muted-foreground",
  },
  // `.meta`: 12px, line 1.5.
  meta: {
    size: "text-caption",
    leading: "leading-normal",
    tone: "text-subtle-foreground",
  },
  // Counts and marks; the line comes from the parent, as in v4.
  "2xs": { size: "text-2xs", leading: "", tone: "text-subtle-foreground" },
} as const;

export type TextProps = ComponentProps<"p"> & {
  readonly as?: "p" | "span" | "div" | undefined;
  readonly variant?: keyof typeof TEXT_VARIANT | undefined;
  /** v4 `.strong`: 500 in the foreground colour. */
  readonly weight?: "medium" | undefined;
  /** v4 `.mono`: the mono face at 12px, on the variant's line. */
  readonly mono?: boolean | undefined;
  /** v4 `.num`: figures of one width, for columns of numbers. */
  readonly numeric?: boolean | undefined;
  /** v4 `.truncate`: one line, cut with an ellipsis. */
  readonly truncate?: boolean | undefined;
};

export function Text({
  as: Tag = "p",
  variant = "body",
  weight,
  mono = false,
  numeric = false,
  truncate = false,
  className,
  ...props
}: TextProps): JSX.Element {
  const { size, leading, tone } = TEXT_VARIANT[variant];
  return (
    <Tag
      data-slot="text"
      data-variant={variant}
      className={cn(
        "m-0",
        // One size class, then the line: a later size would drop the line.
        mono ? "font-mono text-caption" : size,
        leading,
        weight === "medium" ? "font-medium text-foreground" : "font-normal",
        weight === "medium" ? null : tone,
        numeric && "tabular-nums",
        truncate && "min-w-0 truncate",
        className,
      )}
      {...props}
    />
  );
}
