import { describe, expect, test } from "bun:test";

import { canonicalJson, canonicalJsonOfJson } from "./canonical-json.ts";

// Keys whose order localeCompare and code units disagree on: collation puts
// `_` before letters and case after them, code units put `A` < `_` < `a`.
const KEYS = { a_b: 1, aB: 2, ab: 3, Ab: 4 };
const CODE_UNIT_ORDER = '{"Ab":4,"aB":2,"a_b":1,"ab":3}';

describe("canonical JSON (94S-400)", () => {
  test("sorts keys by code unit, not by collation", () => {
    expect(canonicalJson(KEYS)).toBe(CODE_UNIT_ORDER);
    expect(canonicalJsonOfJson({ outer: KEYS })).toBe(
      `{"outer":${CODE_UNIT_ORDER}}`,
    );
  });

  test("writes the same text whatever locale the process runs under", async () => {
    const script = `import { canonicalJson } from ${JSON.stringify(
      new URL("./canonical-json.ts", import.meta.url).pathname,
    )}; process.stdout.write(canonicalJson(${JSON.stringify(KEYS)}));`;
    for (const locale of ["C", "en_US.UTF-8", "tr_TR.UTF-8", "sv_SE.UTF-8"]) {
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, LANG: locale, LC_ALL: locale },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [stdout, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      expect({ code, locale, stdout }).toEqual({
        code: 0,
        locale,
        stdout: CODE_UNIT_ORDER,
      });
    }
  });

  test("the JSON form leaves an undefined property out and reads -0 as 0, as JSON.stringify does", () => {
    expect(canonicalJsonOfJson({ b: undefined, a: -0, c: [undefined] })).toBe(
      '{"a":0,"c":[null]}',
    );
    expect(() => canonicalJson({ b: undefined })).toThrow(TypeError);
  });
});
