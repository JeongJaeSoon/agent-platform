import { expect, test } from "bun:test";
import {
  apiErrorCodeSchema,
  getReceiptResponseSchema,
  receiptErrorSchema,
} from "@werft-ai/contracts";
import { createApiClient } from "./client.ts";
import { unwrap } from "./errors.ts";

const receipt = {
  id: "22222222-2222-4222-8222-222222222222",
  operation: "append_message",
  target_ref: {
    session_id: "11111111-1111-4111-8111-111111111111",
    turn_id: "1",
    request_id: null,
  },
  status: "failed",
  result: null,
  error: {
    code: "WORKSPACE_QUOTA_EXCEEDED",
    message: "Free workspace storage",
  },
  created_at: "2026-11-06T00:00:00Z",
  updated_at: "2026-11-06T00:00:00Z",
} as const;

test("new clients validate the workspace quota receipt", () => {
  expect(getReceiptResponseSchema.safeParse(receipt).success).toBe(true);
});

test("old clients keep a new receipt by default; old strict validators report the new enum", async () => {
  const oldSchema = getReceiptResponseSchema.extend({
    error: receiptErrorSchema
      .extend({
        code: apiErrorCodeSchema.exclude(["WORKSPACE_QUOTA_EXCEEDED"]),
      })
      .nullable(),
  });
  const mismatches: unknown[] = [];
  for (const validate of ["off", "warn", "strict"] as const) {
    const client = createApiClient({
      baseUrl: "https://example.invalid",
      validate,
      fetch: async () => Response.json(receipt),
      validators: {
        responses: {
          "GET /v1/receipts/{id}": (body) => {
            const result = oldSchema.safeParse(body);
            return result.success
              ? []
              : result.error.issues.map((issue) => ({
                  path: issue.path.join("."),
                  message: issue.message,
                }));
          },
        },
      },
      onContractMismatch: (mismatch) => mismatches.push(mismatch),
    });
    const call = unwrap(
      client.GET("/v1/receipts/{id}", { params: { path: { id: receipt.id } } }),
    );
    if (validate === "strict")
      await expect(call).rejects.toMatchObject({
        code: "CLIENT_CONTRACT_MISMATCH",
      });
    else expect(await call).toEqual(receipt);
  }
  expect(mismatches).toHaveLength(1);
});
