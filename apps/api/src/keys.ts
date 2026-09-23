import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  SESSION_SCOPE_VALUES,
  type SessionScope,
  sessionScopeSchema,
} from "@agent-platform/contracts";
import {
  type ApiKeyRecord,
  type ApiKeyRevocation,
  createApiKey,
  type Database,
  findApiKey,
  revokeApiKey,
} from "@agent-platform/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export interface ApiKeyStore {
  find(keyHash: Uint8Array): Promise<ApiKeyRecord | null>;
}

export interface ApiKeyWriter {
  create(input: {
    id: string;
    ownerId: string;
    keyHash: Uint8Array;
    scopes: readonly SessionScope[];
  }): Promise<void>;
  revoke(keyId: string): Promise<ApiKeyRevocation>;
}

export function hashApiKey(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

export function generateApiKey(): string {
  return `csp_${randomBytes(32).toString("base64url")}`;
}

export class DatabaseApiKeyStore implements ApiKeyStore, ApiKeyWriter {
  constructor(private readonly db: Database) {}

  find(keyHash: Uint8Array): Promise<ApiKeyRecord | null> {
    return findApiKey(this.db, keyHash);
  }

  async create(input: {
    id: string;
    ownerId: string;
    keyHash: Uint8Array;
    scopes: readonly SessionScope[];
  }): Promise<void> {
    await createApiKey(this.db, input);
  }

  revoke(keyId: string): Promise<ApiKeyRevocation> {
    return revokeApiKey(this.db, keyId);
  }
}

/**
 * `--scopes` is required: a key that silently got every scope, recovery
 * included, is what scoped keys exist to stop. Order and duplicates do not
 * matter; the stored list is the vocabulary's order.
 */
export function parseScopes(value: string): SessionScope[] {
  const words = value
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    throw new Error("--scopes must name at least one scope");
  }
  const unknown = words.filter(
    (word) => !sessionScopeSchema.safeParse(word).success,
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown scope ${unknown.join(", ")}; expected ${SESSION_SCOPE_VALUES.join(", ")}`,
    );
  }
  return SESSION_SCOPE_VALUES.filter((scope) => words.includes(scope));
}

export async function issueApiKey(
  writer: Pick<ApiKeyWriter, "create">,
  input: { ownerId: string; scopes: readonly SessionScope[] },
  generate: () => string = generateApiKey,
): Promise<{ keyId: string; plaintext: string }> {
  const normalizedOwnerId = input.ownerId.trim();
  if (!normalizedOwnerId) {
    throw new Error("owner_id must not be empty");
  }
  if (input.scopes.length === 0) {
    throw new Error("an API key needs at least one scope");
  }
  const plaintext = generate();
  const keyId = randomUUID();
  await writer.create({
    id: keyId,
    ownerId: normalizedOwnerId,
    keyHash: hashApiKey(plaintext),
    scopes: input.scopes,
  });
  return { keyId, plaintext };
}

const USAGE = `Usage: bun run src/keys.ts create <owner_id> --scopes <scope>[,<scope>...]
       bun run src/keys.ts revoke <key_id>
Scopes: ${SESSION_SCOPE_VALUES.join(", ")}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KeysCommand =
  | { command: "create"; ownerId: string; scopes: SessionScope[] }
  | { command: "revoke"; keyId: string };

function parseStrict(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: { scopes: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
  }
}

export function parseKeysCommand(argv: string[]): KeysCommand {
  const parsed = parseStrict(argv);
  const [command, target, ...extra] = parsed.positionals;
  if (!target || extra.length > 0) {
    throw new Error(USAGE);
  }
  if (command === "revoke") {
    if (parsed.values.scopes !== undefined) throw new Error(USAGE);
    // Checked here: a malformed id would reach the uuid column as a 22P02.
    if (!UUID.test(target)) {
      throw new Error(`key_id must be a UUID\n${USAGE}`);
    }
    return { command: "revoke", keyId: target.toLowerCase() };
  }
  if (command !== "create") {
    throw new Error(USAGE);
  }
  if (parsed.values.scopes === undefined) {
    throw new Error(`--scopes is required\n${USAGE}`);
  }
  return {
    command: "create",
    ownerId: target,
    scopes: parseScopes(parsed.values.scopes),
  };
}

async function main(): Promise<void> {
  const command = parseKeysCommand(Bun.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const store = new DatabaseApiKeyStore(drizzle(pool));
    if (command.command === "revoke") {
      const result = await store.revoke(command.keyId);
      if (result.outcome === "not_found") {
        console.error(`API key ${command.keyId} not found`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `${result.outcome} ${command.keyId} owner=${result.ownerId} revoked_at=${result.revokedAt.toISOString()}`,
      );
      return;
    }
    const issued = await issueApiKey(store, command);
    // stdout carries the plaintext alone so scripts can capture it; the id,
    // which `revoke` takes, goes to stderr.
    console.error(`key_id ${issued.keyId}`);
    console.log(issued.plaintext);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
