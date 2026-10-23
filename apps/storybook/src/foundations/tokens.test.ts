import { describe, expect, test } from "bun:test";
import { parseTokens, withPrefix } from "./tokens.ts";

const css = await Bun.file(
  `${import.meta.dir}/../../../../packages/ui/src/foundations/tokens.css`,
).text();

describe("Foundations 토큰 표", () => {
  const { light, dark } = parseTokens(css);

  test("표가 그리는 갈래마다 tokens.css의 토큰을 읽는다", () => {
    for (const prefix of [
      "--ap-color-",
      "--ap-tone-",
      "--ap-text-",
      "--ap-space-",
      "--ap-radius-",
      "--ap-shadow-",
      "--ap-motion-",
    ]) {
      expect(withPrefix(light, prefix).length).toBeGreaterThan(0);
    }
  });

  test("여러 줄 값을 한 줄로 읽고 주석 속 이름은 토큰으로 세지 않는다", () => {
    expect(light.get("--ap-font-sans")).toStartWith("Geist, ");
    expect(light.get("--ap-color-surface")).toBe("#ffffff");
  });

  test("다크는 수동 전환 블록의 값이고 다크가 바꾸지 않는 토큰은 라이트 값을 쓴다", () => {
    expect(dark.get("--ap-color-surface")).toBe("#0a0a0a");
    expect(dark.get("--ap-radius-card")).toBe(light.get("--ap-radius-card"));
    expect([...dark.keys()]).toEqual([...light.keys()]);
  });
});
