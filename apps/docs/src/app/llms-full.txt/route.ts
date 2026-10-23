import { i18n } from "@/lib/i18n";
import { docsLlms } from "@/lib/source";

export const revalidate = false;

export async function GET() {
  return new Response(await docsLlms.full(i18n.defaultLanguage));
}
