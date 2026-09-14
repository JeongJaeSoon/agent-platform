import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createApiKey,
  type Database,
  findApiKeyOwner,
} from "@claude-session-platform/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export interface ApiKeyStore {
  findOwner(keyHash: Uint8Array): Promise<string | null>;
}

export interface ApiKeyWriter {
  create(input: {
    id: string;
    ownerId: string;
    keyHash: Uint8Array;
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

  findOwner(keyHash: Uint8Array): Promise<string | null> {
    return findApiKeyOwner(this.db, keyHash);
  }

  async create(input: {
    id: string;
    ownerId: string;
    keyHash: Uint8Array;
  }): Promise<void> {
    await createApiKey(this.db, input);
  }
}

export async function issueApiKey(
  writer: ApiKeyWriter,
  ownerId: string,
  generate: () => string = generateApiKey,
): Promise<string> {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId) {
    throw new Error("owner_id must not be empty");
  }
  const plaintext = generate();
  await writer.create({
    id: randomUUID(),
    ownerId: normalizedOwnerId,
    keyHash: hashApiKey(plaintext),
  });
  return plaintext;
}

async function main(): Promise<void> {
  const [command, ownerId, ...extra] = Bun.argv.slice(2);
  if (command !== "create" || !ownerId || extra.length > 0) {
    throw new Error("Usage: bun run src/keys.ts create <owner_id>");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const store = new DatabaseApiKeyStore(drizzle(pool));
    const plaintext = await issueApiKey(store, ownerId);
    console.log(plaintext);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
