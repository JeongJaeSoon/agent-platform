import { describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  openSecret,
  type SecretAadFields,
  SecretDecryptError,
  SecretKey,
  SecretKeyError,
  sealSecret,
} from "./secret-cipher.ts";

const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");
const fields: SecretAadFields = {
  id: randomUUID(),
  workspaceId: randomUUID(),
  ownerRef: "workspace",
  purpose: "slack_config_token",
  secretVersion: 1,
  keyVersion: 1,
};
const value = `xoxe-1-${randomBytes(24).toString("hex")}`;

describe("secret cipher", () => {
  test("a sealed value opens with the same key and fields", () => {
    const sealed = sealSecret(key, fields, value);
    expect(sealed.ciphertext.includes(Buffer.from(value))).toBe(false);
    expect(openSecret(key, fields, sealed)).toBe(value);
  });

  test("two seals of one value differ", () => {
    const a = sealSecret(key, fields, value);
    const b = sealSecret(key, fields, value);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  const changed: [keyof SecretAadFields, string | number][] = [
    ["id", randomUUID()],
    ["workspaceId", randomUUID()],
    ["ownerRef", `slack_app:${randomUUID()}`],
    ["purpose", "slack_signing_secret"],
    ["secretVersion", 2],
    ["keyVersion", 2],
  ];
  test.each(changed)("changing only %s fails to decrypt", (field, other) => {
    const sealed = sealSecret(key, fields, value);
    expect(() =>
      openSecret(key, { ...fields, [field]: other }, sealed),
    ).toThrow(SecretDecryptError);
  });

  test("another key, a flipped byte or a swapped nonce fails to decrypt", () => {
    const sealed = sealSecret(key, fields, value);
    const other = SecretKey.fromHex(randomBytes(32).toString("hex"), "OTHER");
    expect(() => openSecret(other, fields, sealed)).toThrow(SecretDecryptError);
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      openSecret(key, fields, { ...sealed, ciphertext: flipped }),
    ).toThrow(SecretDecryptError);
    expect(() =>
      openSecret(key, fields, { ...sealed, nonce: randomBytes(12) }),
    ).toThrow(SecretDecryptError);
  });

  test("a decrypt error says nothing about the value", () => {
    const sealed = sealSecret(key, fields, value);
    try {
      openSecret(key, { ...fields, secretVersion: 9 }, sealed);
      throw new Error("expected a failure");
    } catch (error) {
      expect(String(error)).not.toContain(value);
      expect(String(error)).not.toContain(value.slice(-4));
    }
  });

  test.each([
    ["empty", ""],
    ["short", "ab".repeat(31)],
    ["long", "ab".repeat(33)],
    ["not hex", "zz".repeat(32)],
    ["padded", ` ${"ab".repeat(32)}`],
  ])("a %s master key is refused without echoing it", (_, bad) => {
    let message = "";
    try {
      SecretKey.fromHex(bad, "PLATFORM_SECRET_KEY");
    } catch (error) {
      expect(error).toBeInstanceOf(SecretKeyError);
      message = (error as Error).message;
    }
    expect(message).toContain("PLATFORM_SECRET_KEY");
    if (bad.trim() !== "") expect(message).not.toContain(bad.trim());
  });

  test("the key serializes to nothing of its bytes", () => {
    const hex = randomBytes(32).toString("hex");
    const k = SecretKey.fromHex(hex, "K");
    expect(JSON.stringify({ k })).not.toContain(hex);
    expect(Bun.inspect(k)).not.toContain(hex.slice(0, 16));
  });

  test("a field holding the separator is refused", () => {
    expect(() =>
      sealSecret(key, { ...fields, ownerRef: "a|b" }, value),
    ).toThrow();
  });
});
