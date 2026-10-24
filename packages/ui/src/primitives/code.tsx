import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type CodeProps = ComponentProps<"code">;

/** Code inside a line of text: the mono face at 12px, with no fill (v4). */
export function Code({ className, ...props }: CodeProps): JSX.Element {
  return (
    <code
      data-slot="code"
      className={cn("font-mono font-normal text-caption", className)}
      {...props}
    />
  );
}

export type CodeBlockProps = ComponentProps<"pre">;

/**
 * Mockup v4's `.code`: lines of code or tool output, wrapped rather than
 * scrolled, so a long line never widens a 390px page.
 */
export function CodeBlock({
  className,
  children,
  ...props
}: CodeBlockProps): JSX.Element {
  return (
    <pre
      data-slot="code-block"
      className={cn(
        "m-0 whitespace-pre-wrap wrap-anywhere rounded-control border bg-muted px-3 py-2 font-mono font-normal text-caption text-foreground leading-[1.6]",
        className,
      )}
      {...props}
    >
      {/* The UA's `code` face would replace the kit's mono list. */}
      <code className="font-mono">{children}</code>
    </pre>
  );
}
