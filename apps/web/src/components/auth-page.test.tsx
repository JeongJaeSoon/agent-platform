import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FormError } from "./auth-page.tsx";

describe("FormError", () => {
  test("is a body-size alert line in the error colour", () => {
    const html = renderToStaticMarkup(<FormError>실패</FormError>);
    const classes = /class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? [];
    expect(html.startsWith("<p")).toBe(true);
    expect(html).toContain('role="alert"');
    expect(html).toContain(">실패<");
    for (const name of ["text-control", "leading-5", "text-destructive"])
      expect(classes).toContain(name);
    expect(classes).not.toContain("text-foreground");
  });
});
