import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
} from "fumadocs-ui/layouts/notebook/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OpenAPIPage } from "@/components/api-page";
import { getMDXComponents } from "@/components/mdx";
import { getPageMarkdownUrl } from "@/lib/shared";
import { source } from "@/lib/source";

interface Props {
  params: Promise<{ slug?: string[] }>;
}

export default async function Page(props: Props) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  if (page.type === "openapi") {
    return (
      <DocsPage full>
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
        <DocsBody>
          <OpenAPIPage {...page.data.getOpenAPIPageProps()} />
        </DocsBody>
      </DocsPage>
    );
  }

  const MDX = page.data.body;
  const isHome = page.slugs.length === 0;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full ?? isHome}>
      {isHome ? null : (
        <>
          <DocsTitle>{page.data.title}</DocsTitle>
          <DocsDescription className="mb-0">
            {page.data.description}
          </DocsDescription>
          <div className="flex flex-row items-center gap-2 border-b pb-6">
            <MarkdownCopyButton markdownUrl={getPageMarkdownUrl(page).url} />
          </div>
        </>
      )}
      <DocsBody>
        <MDX
          components={getMDXComponents({ a: createRelativeLink(source, page) })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
