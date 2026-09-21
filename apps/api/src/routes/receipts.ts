import {
  getReceiptResponseSchema,
  receiptIdParamsSchema,
} from "@agent-platform/contracts";
import type { SessionService } from "@agent-platform/platform";
import { type ApiRouter, jsonWithSchema } from "../app.ts";
import { mapped, requireParams } from "./sessions.ts";

// Error statuses the handler can produce; the OpenAPI parity test holds the
// route table to this.
export const receiptRouteErrors: Record<string, number[]> = {
  "GET /v1/receipts/{id}": [401, 404, 503],
};

export function registerReceiptRoutes(
  router: ApiRouter,
  service: SessionService,
) {
  router.get("/receipts/:id", async (context) => {
    const params = requireParams(context, receiptIdParamsSchema);
    const receipt = await mapped(() =>
      service.getReceipt({ ownerId: context.get("ownerId") }, params.id),
    );
    return jsonWithSchema(context, getReceiptResponseSchema, receipt);
  });
}
