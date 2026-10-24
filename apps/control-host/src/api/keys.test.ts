import { describe, expect, test } from "bun:test";
import {
  type ApiKeyWriter,
  hashApiKey,
  issueApiKey,
  parseKeysCommand,
} from "./keys.ts";

describe("API key issuance", () => {
  test("persists only a SHA-256 digest and the scopes, returns plaintext once", async () => {
    const persisted: Parameters<ApiKeyWriter["create"]>[0][] = [];
    const writer: Pick<ApiKeyWriter, "create"> = {
      async create(input) {
        persisted.push(input);
      },
    };
    const plaintext = "csp_generated_once";
    const issued = await issueApiKey(
      writer,
      { ownerId: " owner-a ", scopes: ["sessions:read", "sessions:write"] },
      () => plaintext,
    );

    expect(issued.plaintext).toBe(plaintext);
    expect(issued.keyId).toBe(persisted[0]?.id ?? "");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual({
      id: expect.any(String),
      ownerId: "owner-a",
      keyHash: hashApiKey(plaintext),
      scopes: ["sessions:read", "sessions:write"],
      kind: "operator",
    });
    expect(new TextDecoder().decode(persisted[0]?.keyHash)).not.toContain(
      plaintext,
    );
  });

  test("--workspace makes the workspace the owner and --personal whom the key acts for; an owner alone gets an operator key", async () => {
    const persisted: Parameters<ApiKeyWriter["create"]>[0][] = [];
    const writer: Pick<ApiKeyWriter, "create"> = {
      async create(input) {
        persisted.push(input);
      },
    };
    await issueApiKey(writer, {
      ownerId: "owner-a",
      scopes: ["sessions:read"],
    });
    await issueApiKey(writer, {
      workspaceId: WORKSPACE,
      scopes: ["sessions:read"],
      personalFor: USER,
    });
    expect(persisted[0]).toMatchObject({
      ownerId: "owner-a",
      kind: "operator",
    });
    expect(persisted[0]?.workspaceId).toBeUndefined();
    expect(persisted[1]).toMatchObject({
      ownerId: WORKSPACE,
      workspaceId: WORKSPACE,
      kind: "personal",
      createdByUserId: USER,
    });
  });

  test("rejects an empty owner or an empty scope list before persistence", async () => {
    let writes = 0;
    const writer: Pick<ApiKeyWriter, "create"> = {
      async create() {
        writes += 1;
      },
    };
    expect(
      issueApiKey(writer, { ownerId: "   ", scopes: ["sessions:read"] }),
    ).rejects.toThrow("owner_id must not be empty");
    expect(
      issueApiKey(writer, { ownerId: "owner-a", scopes: [] }),
    ).rejects.toThrow("at least one scope");
    expect(writes).toBe(0);
  });
});

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USER = "019a0000-0000-7000-8000-0000000000c1";

describe("keys CLI arguments", () => {
  test("create --workspace issues a member's personal key and never a workspace-wide one", () => {
    expect(() =>
      parseKeysCommand([
        "create",
        "--workspace",
        WORKSPACE.toUpperCase(),
        "--scopes",
        "sessions:read",
      ]),
    ).toThrow("--workspace needs --personal");
    expect(
      parseKeysCommand([
        "create",
        "--workspace",
        WORKSPACE.toUpperCase(),
        "--scopes",
        "sessions:read",
        "--personal",
        USER,
      ]),
    ).toEqual({
      command: "create",
      workspaceId: WORKSPACE,
      scopes: ["sessions:read"],
      personalFor: USER,
    });
  });

  test("--workspace and --personal take UUIDs and refuse a second owner", () => {
    expect(() =>
      parseKeysCommand([
        "create",
        "--workspace",
        "acme",
        "--scopes",
        "sessions:read",
      ]),
    ).toThrow("--workspace must be a UUID");
    expect(() =>
      parseKeysCommand([
        "create",
        "owner-a",
        "--workspace",
        WORKSPACE,
        "--scopes",
        "sessions:read",
      ]),
    ).toThrow("Usage");
    expect(() =>
      parseKeysCommand([
        "create",
        "owner-a",
        "--scopes",
        "sessions:read",
        "--personal",
        USER,
      ]),
    ).toThrow("--personal needs --workspace");
    expect(() =>
      parseKeysCommand(["create", "--workspace", WORKSPACE]),
    ).toThrow("--scopes is required");
    expect(() =>
      parseKeysCommand(["revoke", USER, "--workspace", WORKSPACE]),
    ).toThrow("Usage");
  });

  test("create <owner> --scopes reads the list in the vocabulary's order", () => {
    expect(
      parseKeysCommand([
        "create",
        "owner-a",
        "--scopes",
        "sessions:write, sessions:read,sessions:write",
      ]),
    ).toEqual({
      command: "create",
      ownerId: "owner-a",
      scopes: ["sessions:read", "sessions:write"],
    });
    expect(
      parseKeysCommand(["create", "owner-a", "--scopes=sessions:recover"]),
    ).toEqual({
      command: "create",
      ownerId: "owner-a",
      scopes: ["sessions:recover"],
    });
  });

  test("--scopes is required: no silent all-scope key", () => {
    expect(() => parseKeysCommand(["create", "owner-a"])).toThrow(
      "--scopes is required",
    );
    expect(() =>
      parseKeysCommand(["create", "owner-a", "--scopes", ","]),
    ).toThrow("at least one scope");
  });

  test("an unknown scope, flag or extra argument is refused", () => {
    expect(() =>
      parseKeysCommand(["create", "owner-a", "--scopes", "sessions:admin"]),
    ).toThrow("Unknown scope sessions:admin");
    expect(() =>
      parseKeysCommand(["create", "owner-a", "--scope", "sessions:read"]),
    ).toThrow("Usage");
    expect(() =>
      parseKeysCommand([
        "create",
        "owner-a",
        "extra",
        "--scopes",
        "sessions:read",
      ]),
    ).toThrow("Usage");
    expect(() => parseKeysCommand(["rotate", "owner-a"])).toThrow("Usage");
  });

  test("revoke <key_id> takes one UUID and no scopes", () => {
    const keyId = "0B9F1C2E-6A4D-4E8B-9C3F-1D2E3F4A5B6C";
    expect(parseKeysCommand(["revoke", keyId])).toEqual({
      command: "revoke",
      keyId: keyId.toLowerCase(),
    });
    expect(() => parseKeysCommand(["revoke", "owner-a"])).toThrow(
      "key_id must be a UUID",
    );
    expect(() => parseKeysCommand(["revoke"])).toThrow("Usage");
    expect(() =>
      parseKeysCommand(["revoke", keyId, "--scopes", "sessions:read"]),
    ).toThrow("Usage");
    expect(() => parseKeysCommand(["revoke", keyId, "extra"])).toThrow("Usage");
  });
});
