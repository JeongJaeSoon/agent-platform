import { describe, expect, test } from "bun:test";
import { type ApiKeyWriter, hashApiKey, issueApiKey } from "./keys.ts";

describe("API key issuance", () => {
  test("persists only a SHA-256 digest and returns plaintext once", async () => {
    const persisted: Array<{
      id: string;
      ownerId: string;
      keyHash: Uint8Array;
    }> = [];
    const writer: ApiKeyWriter = {
      async create(input) {
        persisted.push(input);
      },
    };
    const plaintext = "csp_generated_once";
    const issued = await issueApiKey(writer, " owner-a ", () => plaintext);

    expect(issued).toBe(plaintext);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual({
      id: expect.any(String),
      ownerId: "owner-a",
      keyHash: hashApiKey(plaintext),
    });
    expect(new TextDecoder().decode(persisted[0]?.keyHash)).not.toContain(
      plaintext,
    );
  });

  test("rejects an empty owner before persistence", async () => {
    let writes = 0;
    const writer: ApiKeyWriter = {
      async create() {
        writes += 1;
      },
    };
    expect(issueApiKey(writer, "   ")).rejects.toThrow(
      "owner_id must not be empty",
    );
    expect(writes).toBe(0);
  });
});
