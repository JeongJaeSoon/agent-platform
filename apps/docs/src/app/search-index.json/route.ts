import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

export const revalidate = false;

// Not /api/search: /api on the Pages site is the Scalar reference.
export const { staticGET: GET } = createFromSource(source);
