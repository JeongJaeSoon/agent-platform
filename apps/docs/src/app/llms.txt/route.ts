import { basePath } from "@/lib/shared";
import { docsLlms } from "@/lib/source";

export const revalidate = false;

export async function GET() {
  // The index links page URLs as the loader knows them, without the base path.
  const index = (await docsLlms.index()).replaceAll("](/", `](${basePath}/`);
  return new Response(index, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
