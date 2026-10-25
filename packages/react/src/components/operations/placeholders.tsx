import { Skeleton } from "@werft-ai/ui";
import type { ReactNode } from "react";

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
