import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  SESSION_SCOPE_VALUES,
  type SessionScope,
  sessionScopeSchema,
} from "@agent-platform/contracts";
import {
  type ApiKeyRecord,
  createApiKey,
  type Database,
  findApiKey,
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
  writer: ApiKeyWriter,
  input: { ownerId: string; scopes: readonly SessionScope[] },
  generate: () => string = generateApiKey,
): Promise<string> {
  const normalizedOwnerId = input.ownerId.trim();
  if (!normalizedOwnerId) {
    throw new Error("owner_id must not be empty");
  }
  if (input.scopes.length === 0) {
    throw new Error("an API key needs at least one scope");
  }
  const plaintext = generate();
  await writer.create({
    id: randomUUID(),
    ownerId: normalizedOwnerId,
    keyHash: hashApiKey(plaintext),
    scopes: input.scopes,
  });
  return plaintext;
}

const USAGE = `Usage: bun run src/keys.ts create <owner_id> --scopes <scope>[,<scope>...]
Scopes: ${SESSION_SCOPE_VALUES.join(", ")}`;

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

export function parseKeysCommand(argv: string[]): {
  ownerId: string;
  scopes: SessionScope[];
} {
  const parsed = parseStrict(argv);
  const [command, ownerId, ...extra] = parsed.positionals;
  if (command !== "create" || !ownerId || extra.length > 0) {
    throw new Error(USAGE);
  }
  if (parsed.values.scopes === undefined) {
    throw new Error(`--scopes is required\n${USAGE}`);
  }
  return { ownerId, scopes: parseScopes(parsed.values.scopes) };
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
    const plaintext = await issueApiKey(store, command);
    console.log(plaintext);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
