import { Fragment, type ReactNode } from "react";

const MARK = "\u0000";

/**
 * A translated line with elements in its placeholders, by name, wherever
 * each locale puts them: `withNodes((vars) => t("x", vars), { at: <… /> })`.
 */
export function withNodes(
  translate: (vars: Record<string, string>) => string,
  nodes: Readonly<Record<string, ReactNode>>,
): ReactNode {
  const vars = Object.fromEntries(
    Object.keys(nodes).map((name) => [name, `${MARK}${name}${MARK}`]),
  );
  // Split on the marks: text, name, text, name, …, text.
  return translate(vars)
    .split(MARK)
    .map((piece, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are positional
      <Fragment key={index}>{index % 2 === 0 ? piece : nodes[piece]}</Fragment>
    ));
}
