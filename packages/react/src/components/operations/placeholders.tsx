import { Skeleton } from "@werft-ai/ui";
import type { ReactNode } from "react";

/*
 * Placeholders that hold a value's or a chart's place while it is read, so
 * the layout stands before the data and nothing moves when it comes. They are
 * hidden from assistive tech; each part says once that it is reading.
 */

/** A text value at its line height, or the value once it is read. */
export function Value({
  loading,
  width = "3rem",
  children,
}: {
  readonly loading: boolean;
  readonly width?: string;
  readonly children: ReactNode;
}): ReactNode {
  return loading ? (
    <Skeleton
      inline
      decorative
      width={width}
      height="1lh"
      className="justify-center"
    />
  ) : (
    children
  );
}

/** A box of a chart's or meter's height; under 4rem it centers a text bar. */
export function Box({
  height,
  chart = false,
}: {
  readonly height: string;
  readonly chart?: boolean;
}): ReactNode {
  return (
    <Skeleton
      decorative
      shape={chart ? "block" : "text"}
      height={height}
      className="justify-center"
    />
  );
}
