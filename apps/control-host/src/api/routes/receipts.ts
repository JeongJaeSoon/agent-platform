import {
  getReceiptResponseSchema,
  receiptIdParamsSchema,
} from "@agent-platform/contracts";
import type { SessionService } from "@agent-platform/platform";
import { type ApiRouter, jsonWithSchema } from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

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
