import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import destinations from "../tests/fixtures/self-hosting-language-status.json";
import baseline from "../tests/fixtures/self-hosting-public-urls.json";

const output = join(import.meta.dir, "../apps/docs/out");
const prefix = "/run-server/self-hosting";
const failures: string[] = [];
const cache = new Map<
  string,
  { html: string; ids: Set<string>; links: string[] }
>();

function inspect(path: string) {
  const file = join(output, path, "index.html");
  const cached = cache.get(file);
  if (cached) return cached;
  const html = readFileSync(file, "utf8");
  const ids = new Set(
    [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1] ?? ""),
  );
  const links = [...html.matchAll(/\shref="([^"]*)"/g)].map((m) =>
    (m[1] ?? "").replaceAll("&amp;", "&"),
  );
  const result = { html, ids, links };
  cache.set(file, result);
  return result;
}

let fragments = 0;
for (const old of baseline.pages) {
  const path = `${old.locale}${prefix}${old.page ? `/${old.page}` : ""}`;
  try {
    const page = inspect(path);
    for (const id of old.fragments) {
      fragments++;
      if (!page.ids.has(id)) failures.push(`${path}#${id}: missing fragment`);
    }
  } catch {
    failures.push(`${path}: missing export`);
  }
}

for (const entry of Object.values(destinations)) {
  if ("integrated" in entry) continue;
  for (const path of entry.paths) {
    for (const locale of ["ko", "en", "ja"] as const) {
      const route = `${locale}/${path === "run-server/self-hosting/index" ? path.slice(0, -6) : path}`;
      const page = inspect(route);
      if (entry.locales[locale] === "fallback") {
        const notice =
          locale === "en"
            ? "This page has not been translated into English yet."
            : "このページはまだ日本語に翻訳されていません。";
        if (!page.html.includes(notice))
          failures.push(`${route}: missing fallback notice`);
      }
    }
  }
}

for (const [file, page] of cache) {
  for (const href of page.links) {
    if (!href.startsWith("/werft/") && !href.startsWith("#")) continue;
    const current = file.slice(output.length).replace(/\/index\.html$/, "/");
    const url = new URL(href, `https://docs.invalid/werft${current}`);
    const target = decodeURIComponent(url.pathname.replace(/^\/werft\//, ""));
    if (/^(api|storybook)(\/|$)/.test(target)) continue;
    const pathname = target.replace(/\/$/, "");
    const exact = join(output, pathname);
    const html = join(exact, "index.html");
    if (!existsSync(html) && !existsSync(exact)) {
      failures.push(`${current} -> ${href}: missing output`);
      continue;
    }
    if (
      url.hash &&
      existsSync(html) &&
      !inspect(pathname).ids.has(decodeURIComponent(url.hash.slice(1)))
    ) {
      failures.push(`${current} -> ${href}: missing output fragment`);
    }
  }
}

if (failures.length) {
  console.error([...new Set(failures)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Self-hosting export: ${baseline.pages.length} previous pages, ${fragments} fragments, ${cache.size} HTML pages checked; all links and fallback notices present.`,
  );
}
