import { Fragment, type ReactNode } from "react";

/** Stands in for each node in the translated line `withNodes` splits. */
export const NODE = "\u0000";

/**
 * A translated line with elements where its placeholders go, in the order
 * they appear: `withNodes(t("x", { at: NODE }), <RelativeTime … />)`. Every
 * locale has to keep the placeholders in that order.
 */
export function withNodes(line: string, ...nodes: ReactNode[]): ReactNode {
  return line.split(NODE).map((text, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are positional
    <Fragment key={index}>
      {text}
      {nodes[index]}
    </Fragment>
  ));
}
