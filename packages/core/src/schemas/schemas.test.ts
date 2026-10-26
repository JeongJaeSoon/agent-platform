import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ContractMismatch,
  createApiClient,
  isApiError,
  type ValidateMode,
} from "@werft-ai/client";
import { z } from "zod";
import * as entry from "./index.ts";
import {
  contractValidators,
  responseSchemas,
  warnOncePerIssue,
} from "./index.ts";

const DOCUMENT = join(import.meta.dir, "..", "..", "..", "..", "docs");

interface Document {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
}
interface Operation {
  responses?: Record<
    string,
    { content?: Record<string, { schema?: { $ref?: string } }> }
  >;
}

const openapi = async () =>
  JSON.parse(
    await readFile(join(DOCUMENT, "openapi.json"), "utf8"),
  ) as Document;

const METHODS = ["get", "post", "put", "patch", "delete"];

test("the entry exports the response table, the validators and the warn reporter, nothing else", () => {
  expect(Object.keys(entry).sort()).toEqual([
    "contractValidators",
    "responseSchemas",
    "warnOncePerIssue",
  ]);
});

test("the entry defines no schema of its own: every one is a contracts export", async () => {
  const files = (await readdir(import.meta.dir)).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  const found: string[] = [];
  for (const name of files) {
    const source = await readFile(join(import.meta.dir, name), "utf8");
    for (const match of source.matchAll(/\bz\.\w+\(/g))
      found.push(`${name}: ${match[0]}`);
  }
  expect(found).toEqual([]);
});

test("the table holds exactly the document's JSON answers, each the schema the document publishes", async () => {
  const document = await openapi();
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (typeof node !== "object" || node === null) return node;
    const { $ref, ...rest } = node as Record<string, unknown>;
    const own = Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [key, resolve(value)]),
    );
    if (typeof $ref !== "string") return own;
    const name = $ref.replace("#/components/schemas/", "");
    return {
      ...(resolve(document.components.schemas[name]) as object),
      ...own,
    };
  };
  const published: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const success = Object.entries(item[method]?.responses ?? {}).find(
        ([status]) => status.startsWith("2"),
      )?.[1];
      const schema = success?.content?.["application/json"]?.schema;
      if (schema) published[`${method.toUpperCase()} ${path}`] = schema;
    }
  }
  delete published["GET /v1/openapi.json"];

  expect(Object.keys(responseSchemas).sort()).toEqual(
    Object.keys(published).sort(),
  );
  // The server renders this answer among its request components, as input.
  const renderedAsInput = new Set(["POST /v1/sessions/{id}/answers"]);
  for (const [operation, schema] of Object.entries(responseSchemas)) {
    const { $schema: _, ...ours } = z.toJSONSchema(schema, {
      io: renderedAsInput.has(operation) ? "input" : "output",
    });
    expect({ operation, schema: ours }).toEqual({
      operation,
      schema: resolve(published[operation]) as typeof ours,
    });
  }
});

const KEY_ID = "0b6f4e1c-5a8d-4f2e-9c3b-1a2b3c4d5e6f";
const WORKSPACE_ID = "1c7a5f2d-6b9e-4a3f-8d4c-2b3c4d5e6f70";
const RECEIPT_ID = "2d8b6a3e-7cae-4b40-9e5d-3c4d5e6f7081";
const INVITE_ID = "3e9c7b4f-8dbf-4c51-af6e-4d5e6f708192";
// Plainly fake, but long enough for the contracts' 32-character minimum.
const SECRET = "fixture-secret-value-".repeat(2);
const TOKEN = "fixture-invite-token-".repeat(2);

const createdKey = (extra: Record<string, unknown> = {}) => ({
  key: {
    id: KEY_ID,
    kind: "personal",
    name: null,
    workspace_id: WORKSPACE_ID,
    agent_id: null,
    created_by: null,
    created_by_user: null,
    scopes: ["sessions:read"],
    created_at: "2026-10-21T00:00:00.000Z",
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
  },
  secret: SECRET,
  receipt_id: RECEIPT_ID,
  ...extra,
});

function clientAnswering(body: unknown, validate: ValidateMode) {
  const warnings: unknown[][] = [];
  const client = createApiClient({
    baseUrl: "https://console.test",
    fetch: (async () =>
      new Response(JSON.stringify(body), {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    validate,
    validators: contractValidators,
    onContractMismatch: warnOncePerIssue((...line) => warnings.push(line)),
  });
  const createKey = () =>
    client.POST("/v1/api-keys", {
      body: { kind: "personal", scopes: ["sessions:read"] },
    });
  return { client, createKey, warnings };
}

test("a contract-shaped answer passes strict without a warning", async () => {
  const { createKey, warnings } = clientAnswering(createdKey(), "strict");
  const { data, error } = await createKey();
  expect(error).toBeUndefined();
  expect(data).toEqual(createdKey() as typeof data);
  expect(warnings).toEqual([]);
});

test("warn hands back an answer with an unknown key as it came and never names the key", async () => {
  const body = createdKey({ rotated_secret: SECRET });
  const { createKey, warnings } = clientAnswering(body, "warn");
  const { data } = await createKey();
  expect(data).toEqual(body as typeof data);
  expect(warnings).toEqual([
    [
      "API contract mismatch",
      {
        operation: "POST /v1/api-keys",
        issues: [{ path: "*", message: "unrecognized_keys" }],
      },
    ],
  ]);
});

test("strict throws on the same unknown key", async () => {
  const { createKey } = clientAnswering(
    createdKey({ rotated_secret: SECRET }),
    "strict",
  );
  const thrown = await createKey().catch((error: unknown) => error);
  expect(isApiError(thrown, "CLIENT_CONTRACT_MISMATCH")).toBe(true);
});

test("the same answer twice warns once", async () => {
  const { createKey, warnings } = clientAnswering(
    createdKey({ rotated_secret: SECRET }),
    "warn",
  );
  await createKey();
  await createKey();
  expect(warnings).toHaveLength(1);
});

test("a warning carries no value from the answer, secrets and invite tokens included", async () => {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => lines.push(JSON.stringify(args));
  const original = console.warn;
  console.warn = capture;
  try {
    // The secret breaks its own length rule and sits under an unknown key.
    const key = createdKey({
      secret: `${SECRET}${"x".repeat(256)}`,
      leaked: SECRET,
    });
    // A value can also arrive as a key name.
    const keyIssues = contractValidators.responses?.["POST /v1/api-keys"]?.({
      ...key,
      [SECRET]: true,
    });
    const invite = {
      invite_id: INVITE_ID,
      invite_token: TOKEN,
      expires_at: 7,
      echoed: TOKEN,
    };
    const inviteIssues = contractValidators.responses?.["POST /v1/invites"]?.({
      ...invite,
      [TOKEN]: true,
    });
    const report = warnOncePerIssue();
    report({ operation: "POST /v1/api-keys", issues: keyIssues ?? [] });
    report({ operation: "POST /v1/invites", issues: inviteIssues ?? [] });
  } finally {
    console.warn = original;
  }
  expect(lines).toHaveLength(2);
  const logged = lines.join("\n");
  // Declared field names stay so a warning still says where.
  expect(logged).toContain('"path":"secret","message":"too_big"');
  expect(logged).toContain('"path":"expires_at","message":"invalid_type"');
  expect(logged).toContain('"path":"*","message":"unrecognized_keys"');
  expect(logged).not.toContain("fixture-secret-value");
  expect(logged).not.toContain("fixture-invite-token");
});

test("a record key outside the contract is masked too", () => {
  const issues = contractValidators.responses?.["GET /readyz"]?.({
    status: "ready",
    checks: { database: "ok", [SECRET]: "ok" },
  });
  expect(issues?.length).toBeGreaterThan(0);
  expect(JSON.stringify(issues)).not.toContain("fixture-secret-value");
  expect(issues?.map((issue) => issue.path)).toContain("checks.*");
});

test("issues in many rows of a list collapse to one path", () => {
  const rows = Array.from({ length: 3 }, () => ({ ...createdKey().key, x: 1 }));
  const issues = contractValidators.responses?.["GET /v1/api-keys"]?.({
    items: rows,
    next_cursor: null,
  });
  const logged: ContractMismatch[] = [];
  warnOncePerIssue((_, mismatch) => logged.push(mismatch))({
    operation: "GET /v1/api-keys",
    issues: issues ?? [],
  });
  expect(logged).toEqual([
    {
      operation: "GET /v1/api-keys",
      issues: [{ path: "items.[].*", message: "unrecognized_keys" }],
    },
  ]);
});
