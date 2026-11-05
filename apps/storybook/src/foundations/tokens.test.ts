import { describe, expect, test } from "bun:test";
import { parseTokens, withPrefix } from "./tokens.ts";

const css = await Bun.file(
  `${import.meta.dir}/../../../../packages/ui/src/foundations/tokens.css`,
).text();

describe("Foundations 토큰 표", () => {
  const { light, dark } = parseTokens(css);

  test("표가 그리는 갈래마다 tokens.css의 토큰을 읽는다", () => {
    for (const prefix of [
      "--werft-color-",
      "--werft-tone-",
      "--werft-avatar-",
      "--werft-text-",
      "--werft-space-",
      "--werft-radius-",
      "--werft-shadow-",
      "--werft-motion-",
    ]) {
      expect(withPrefix(light, prefix).length).toBeGreaterThan(0);
    }
  });

  test("여러 줄 값을 한 줄로 읽고 주석 속 이름은 토큰으로 세지 않는다", () => {
    expect(light.get("--werft-font-sans")).toStartWith("Geist, ");
    expect(light.get("--werft-color-surface")).toBe("#ffffff");
  });

  test("다크는 수동 전환 블록의 값이고 다크가 바꾸지 않는 토큰은 라이트 값을 쓴다", () => {
    expect(dark.get("--werft-color-surface")).toBe("#0a0a0a");
    expect(dark.get("--werft-radius-card")).toBe(
      light.get("--werft-radius-card"),
    );
    expect([...dark.keys()]).toEqual([...light.keys()]);
  });
});
