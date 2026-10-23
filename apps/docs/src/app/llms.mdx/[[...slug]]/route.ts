import { notFound } from "next/navigation";
import { i18n, isLocale } from "@/lib/i18n";
import { getPageMarkdownUrl } from "@/lib/shared";
import { docsLlms, source } from "@/lib/source";

export const revalidate = false;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug = [] } = await params;
  // The last segment is the "content.md" file name. Paths from before
  // languages carry no language and stay Korean.
  const [first, ...rest] = slug.slice(0, -1);
  const page = isLocale(first)
    ? source.getPage(rest, first)
    : source.getPage(slug.slice(0, -1), i18n.defaultLanguage);
  if (!page) notFound();

  return new Response(await docsLlms.page(page), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export function generateStaticParams() {
  const pages = source.getPages();
  const legacy = source
    .getPages(i18n.defaultLanguage)
    .map((page) => ({ slug: [...page.slugs, "content.md"] }));
  return [
    ...pages.map((page) => ({ slug: getPageMarkdownUrl(page).segments })),
    ...legacy,
  ];
}
