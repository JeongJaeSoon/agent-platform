/**
 * Records the demo build's fixtures from a running stack: signs in once,
 * serves the console's production build through a proxy that forwards only
 * GETs (the stack is never written to), walks every screen the console links
 * to in headless Chrome, and saves each answer.
 *
 *   bun run --cwd apps/web build
 *   bun apps/web/scripts/demo-record.ts --api http://127.0.0.1:4611 \
 *     --accounts <accounts.md> --out <demo>/fixtures.json \
 *     [--account owner] [--max-pages 500]
 *
 * <accounts.md> holds the stack's account table between `<!-- accounts -->`
 * markers, one row per account: key | role | name | email | password | ...
 * The password is read from it and never printed. <demo> is a checkout of
 * JeongJaeSoon/agent-platform-demo; README "콘솔 데모" has the steps that
 * follow (gitleaks fingerprints, demo-scan, the push).
 */
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@werft-ai/client";
import { type Browser, chromium, type Page } from "playwright-core";
import { type DemoResponse, fixtureKey } from "../src/demo/fetch.ts";
import { sanitize } from "./demo-scan.ts";

const { values: args } = parseArgs({
  options: {
    api: { type: "string" },
    accounts: { type: "string" },
    account: { type: "string", default: "owner" },
    out: { type: "string" },
    "max-pages": { type: "string", default: "500" },
  },
});
if (!args.api || !args.accounts || !args.out) {
  console.error(
    "usage: demo-record.ts --api <url> --accounts <file> --out <fixtures.json>",
  );
  process.exit(2);
}
const api = args.api.replace(/\/$/, "");
const dist = new URL("../dist/", import.meta.url).pathname;
const maxPages = Number(args["max-pages"]);

const STREAM_IDLE_MS = 2_000;
const STREAM_MAX_MS = 15_000;
const PAGE_IDLE_MS = 600;
const PAGE_MAX_MS = 10_000;

/** Query variants no link carries: the filters a person picks on screen. */
const SEEDS = [
  "/",
  ...["needs_input", "running", "idle", "stopped", "failed"].map(
    (status) => `/sessions?status=${status}`,
  ),
  ...["started", "shared", "administered"].map(
    (relation) => `/sessions?relation=${relation}`,
  ),
  ...["", "/usage", "/tools", "/limits"].flatMap((tab) =>
    ["7", "30", "90"].flatMap((days) =>
      ["me", "installation"].map(
        (scope) => `/operations${tab}?days=${days}&scope=${scope}`,
      ),
    ),
  ),
];

async function account(): Promise<{ email: string; password: string }> {
  const text = await readFile(args.accounts as string, "utf8");
  const table = text.split("<!-- accounts -->")[1]?.split("<!-- /accounts")[0];
  for (const line of table?.split("\n") ?? []) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells[1] !== args.account) continue;
    const unquote = (cell = "") => cell.replace(/^`|`$/g, "");
    return { email: unquote(cells[4]), password: unquote(cells[5]) };
  }
  throw new Error(`no "${args.account}" row in the accounts table`);
}

async function signIn(): Promise<string> {
  const response = await fetch(`${api}/v1/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
    },
    body: JSON.stringify(await account()),
  });
  if (!response.ok) throw new Error(`login answered ${response.status}`);
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("login set no cookie");
  return cookie;
}

const responses = new Map<string, DemoResponse>();
let inflight = 0;
let lastActivity = Date.now();

async function recordStream(upstream: Response): Promise<string> {
  const reader = upstream.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  const started = Date.now();
  let text = "";
  for (;;) {
    const left = STREAM_MAX_MS - (Date.now() - started);
    if (left <= 0) break;
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.min(STREAM_IDLE_MS, left)).then(() => null),
    ]);
    if (!next || next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  // Whole frames only, without keepalive comments.
  return text
    .split("\n\n")
    .filter((frame) => frame.trim() && !frame.startsWith(":"))
    .filter(
      (_frame, index, all) => index < all.length - 1 || text.endsWith("\n\n"),
    )
    .map((frame) => `${frame}\n\n`)
    .join("");
}

async function proxy(request: Request, cookie: string): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET")
    return Response.json(
      { error: { code: "FORBIDDEN", message: "recording is read-only" } },
      { status: 405 },
    );
  const key = fixtureKey(url);
  const known = responses.get(key);
  if (known)
    return "sse" in known
      ? new Response(known.sse, {
          headers: { "content-type": "text/event-stream" },
        })
      : Response.json(known.json, { status: known.status });
  const upstream = await fetch(`${api}${url.pathname}${url.search}`, {
    headers: {
      cookie,
      accept: request.headers.get("accept") ?? "*/*",
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
    },
  });
  const type = upstream.headers.get("content-type") ?? "";
  if (type.startsWith("text/event-stream")) {
    const sse = await recordStream(upstream);
    responses.set(key, { status: 200, sse });
    return new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    });
  }
  if (upstream.status === 204) {
    responses.set(key, { status: 204, json: null });
    return new Response(null, { status: 204 });
  }
  if (!type.includes("json")) {
    console.warn(`skipped ${key}: ${upstream.status} ${type}`);
    return new Response(upstream.body, upstream);
  }
  const json: unknown = await upstream.json();
  responses.set(key, { status: upstream.status, json });
  return Response.json(json, { status: upstream.status });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/plain",
};

async function asset(pathname: string): Promise<Response> {
  const path = normalize(join(dist, pathname));
  const file = Bun.file(
    path.startsWith(dist) && extname(path) ? path : join(dist, "index.html"),
  );
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, {
    headers: {
      "content-type": CONTENT_TYPES[extname(file.name ?? "")] ?? "",
    },
  });
}

async function waitIdle(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < PAGE_MAX_MS) {
    await Bun.sleep(100);
    if (inflight === 0 && Date.now() - lastActivity > PAGE_IDLE_MS) return;
  }
}

/** Internal links on the page, as router paths with their search. */
async function links(page: Page, origin: string): Promise<string[]> {
  const hrefs = await page.$$eval("a[href]", (anchors) =>
    anchors.map((a) => (a as HTMLAnchorElement).href),
  );
  return hrefs.flatMap((href) => {
    const url = new URL(href);
    if (url.origin !== origin || url.pathname.startsWith("/v1/")) return [];
    if (url.pathname === "/login" || url.pathname.endsWith("/callback"))
      return [];
    return [`${url.pathname}${url.search}`];
  });
}

/** Tabs and dialogs fetch on open; nothing here submits. */
async function openEverything(page: Page): Promise<void> {
  for (const tab of await page.$$('[role="tab"]')) {
    await tab.click({ timeout: 2_000 }).catch(() => {});
    await waitIdle();
  }
  for (const opener of await page.$$('button[aria-haspopup="dialog"]')) {
    await opener.click({ timeout: 2_000 }).catch(() => {});
    await waitIdle();
    await page.keyboard.press("Escape");
  }
}

const cookie = await signIn();
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
try {
  server = Bun.serve({
    // Anyone who reaches this port reads the API as the signed-in owner.
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(request) {
      inflight += 1;
      try {
        const { pathname } = new URL(request.url);
        return pathname.startsWith("/v1/")
          ? await proxy(request, cookie)
          : await asset(pathname);
      } finally {
        inflight -= 1;
        lastActivity = Date.now();
      }
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
  });
  const seen = new Set<string>();
  const queue = [...SEEDS];
  while (queue.length > 0 && seen.size < maxPages) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    await page.goto(`${origin}${path}`, { waitUntil: "load" });
    await waitIdle();
    await openEverything(page);
    for (const link of await links(page, origin))
      if (!seen.has(link)) queue.push(link);
    console.log(`${seen.size} ${path} (${responses.size} answers)`);
  }
  if (queue.length > 0) console.warn(`stopped with ${queue.length} unvisited`);
} finally {
  await browser?.close().catch(() => {});
  // The login is the one write this script makes; take it back.
  await fetch(`${api}/v1/auth/logout`, {
    method: "POST",
    headers: { cookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  }).catch(() => {});
  server?.stop(true);
}

const sorted = Object.fromEntries(
  [...responses].sort(([a], [b]) => a.localeCompare(b)),
);
const fixtures = {
  recorded_at: new Date().toISOString(),
  responses: sorted,
};
await writeFile(
  args.out as string,
  `${sanitize(JSON.stringify(fixtures, null, 2))}\n`,
);
console.log(`wrote ${responses.size} answers to ${args.out}`);
