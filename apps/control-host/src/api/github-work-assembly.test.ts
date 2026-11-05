import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// server.ts builds the review service twice: for the session API and, per
// grant, for the built-in `github` MCP server. Both must pass the shared
// redactor, or a review body would reach GitHub uncleaned on one path.
test("both assemblies of the GitHub work service pass the shared redactor", () => {
  const path = new URL("./server.ts", import.meta.url);
  const source = ts.createSourceFile(
    "server.ts",
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const redactors: Array<string | null> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createGitHubWorkService"
    ) {
      const [options] = node.arguments;
      const redact =
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name) &&
                property.name.text === "redact",
            )
          : undefined;
      redactors.push(redact?.initializer.getText(source) ?? null);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  console.log("createGitHubWorkService redact arguments:", redactors);
  expect(redactors).toEqual(["sanitizeText", "sanitizeText"]);
});
