import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { withNodes } from "./with-nodes.tsx";

const fill = (template: string) => (vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? "");

describe("withNodes", () => {
  test("자리표시자 이름으로 노드를 넣어, 번역이 순서를 바꿔도 맞는 자리에 간다", () => {
    const nodes = { from: <b>A</b>, to: <i>B</i> };
    expect(renderToStaticMarkup(withNodes(fill("{from} ~ {to}"), nodes))).toBe(
      "<b>A</b> ~ <i>B</i>",
    );
    expect(
      renderToStaticMarkup(withNodes(fill("{to}まで {from}から"), nodes)),
    ).toBe("<i>B</i>まで <b>A</b>から");
  });
});
