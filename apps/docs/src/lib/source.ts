import { type LoaderPlugin, llms, loader } from "fumadocs-core/source";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { openapi, slugifyTag } from "./openapi";
import { appName, withBasePath } from "./shared";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: { includeProcessedMarkdown: true },
  },
  meta: { schema: metaSchema },
});

// `external:[..](/storybook/)` in a meta.json names a sibling site on the same
// Pages origin; it renders as a plain <a>, so the base path is added here. The
// generated reference folder has no meta.json to title it.
const pageTreeFixes: LoaderPlugin = {
  name: "page-tree-fixes",
  transformPageTree: {
    file(node) {
      if (node.external && node.url.startsWith("/")) {
        return { ...node, url: withBasePath(node.url) };
      }
      return node;
    },
    folder(node, folderPath) {
      return folderPath === "reference/http-api"
        ? { ...node, name: "HTTP API" }
        : node;
    },
  },
};

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    openapi: await openapi.staticSource({
      baseDir: "reference/http-api",
      groupBy: "tag",
      slugify: slugifyTag,
      meta: true,
    }),
  },
  {
    baseUrl: "/",
    plugins: [openapi.loaderPlugin(), pageTreeFixes],
  },
);

export const docsLlms = llms(source, {
  // Operation items carry a method badge as their name; the title is plain text.
  renderName: (node) => {
    if (node.type === "page") return source.getNodePage(node)?.data.title ?? "";
    return node.type === "folder" ? String(node.name) : `${appName} 문서`;
  },
  // Operation descriptions run to several paragraphs; an index line keeps the first.
  renderDescription: (node) => {
    const description =
      node.type === "page"
        ? source.getNodePage(node)?.data.description
        : undefined;
    return description?.split("\n")[0] ?? "";
  },
  renderPage: async (page) => {
    const heading = `# ${page.data.title} (${withBasePath(page.url)})`;
    if (page.type === "openapi")
      return `${heading}\n\n${page.data.description ?? ""}`;
    return `${heading}\n\n${await page.data.getText("processed")}`;
  },
});
