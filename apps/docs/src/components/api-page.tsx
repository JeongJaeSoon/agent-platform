"use client";
import { createOpenAPIPage } from "fumadocs-openapi/ui";
import { preload } from "react-dom";
import { withBasePath } from "@/lib/shared";

const documentUrl = (id: string) => withBasePath(`/openapi/${id}`);

export const OpenAPIPage = createOpenAPIPage({
  // No API server sits behind the static site, so there is nothing to call.
  playground: { enabled: false },
  async loadDocument(id) {
    if (typeof window === "undefined") {
      preload(documentUrl(id), { as: "fetch", crossOrigin: "anonymous" });
      const { openapi } = await import("@/lib/openapi");
      return (await openapi.getSchema(id)).bundled;
    }
    return (await fetch(documentUrl(id))).json();
  },
});
