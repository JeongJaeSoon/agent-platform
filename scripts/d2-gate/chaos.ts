/**
 * The D2 gate's fault injector (94S-247): a pass-through HTTP proxy that
 * sits between workers and the two things they write to — the Worker
 * Gateway (`:3000` → api:3000) and the object store (`:4566` →
 * localstack:4566). The scheduler hands workers these addresses in place of
 * the real ones, and the egress proxy allowlists only these, so every write
 * a worker makes is seen here and none can go around it.
 *
 * Faults are rules armed from the host over the control port (`:8099`):
 * - `lose_response`: forward, let the upstream commit, answer the worker a
 *   bare 502 — the response lost on the way back.
 * - `fail`: answer an S3-style 500 without forwarding.
 * - `delay`: hold the request `delayMs` before forwarding it (94S-135 races).
 * - `hold`: hold the request until the rule is released
 *   (`POST /rules/<id>/release`) or removed, or `delayMs` passes if set — so
 *   a race can let it through only after its other half has happened.
 * - `corrupt`: forward, then flip a byte in the middle of the answer's body,
 *   status and headers kept — damage only a digest check can catch.
 * Each rule matches a method, a path pattern and optionally a substring of
 * the body, and fires `times` times (-1: until removed).
 */

type Upstream = "gateway" | "s3";

type Rule = {
  action: "corrupt" | "delay" | "fail" | "hold" | "lose_response";
  bodyContains?: string;
  delayMs?: number;
  fired: number;
  id: string;
  method?: string;
  path: string;
  times: number;
  upstream: Upstream;
};

type Batch = {
  key: string;
  /** source_sequence → sha256 of the event as sent. */
  events: Record<number, string>;
};

type Entry = {
  at: string;
  /** An append-events call's batch, so a retry can be matched to its original. */
  batch: Batch | null;
  bodyBytes: number;
  /** A `corrupt` rule changed a byte of this (2xx, non-empty) answer. */
  corrupted: boolean;
  /** When the request went on upstream; null while held or never. */
  forwardedAt: string | null;
  index: number;
  method: string;
  path: string;
  rule: string | null;
  sessionId: string | null;
  status: number;
  upstream: Upstream;
  upstreamStatus: number | null;
};

const UPSTREAMS: Record<Upstream, { listen: number; target: string }> = {
  gateway: {
    listen: 3000,
    target: process.env.CHAOS_GATEWAY_TARGET ?? "http://api:3000",
  },
  s3: {
    listen: 4566,
    target: process.env.CHAOS_S3_TARGET ?? "http://localstack:4566",
  },
};

const rules: Rule[] = [];
/** Release switches of `hold` rules, by rule id. */
const gates = new Map<string, () => void>();
const released = new Map<string, Promise<void>>();
const log: Entry[] = [];
// A soak runs for a day, so it keeps only the newest entries; `index` still
// counts every request, which keeps a `since` cursor valid.
const LOG_MAX = Number(process.env.CHAOS_LOG_MAX ?? "0");
let received = 0;
const SESSION_IN_BODY = /"session_id"\s*:\s*"([0-9a-f-]{36})"/;
const SESSION_IN_PATH = /sessions\/([0-9a-f-]{36})\//;
// Keys the proxy must not copy onto the upstream request as-is.
const HOP_HEADERS = ["host", "connection", "content-length", "keep-alive"];

function matching(
  upstream: Upstream,
  method: string,
  path: string,
  body: string,
): Rule | undefined {
  return rules.find(
    (rule) =>
      rule.upstream === upstream &&
      (rule.times < 0 || rule.fired < rule.times) &&
      (rule.method === undefined || rule.method === method) &&
      new RegExp(rule.path).test(path) &&
      (rule.bodyContains === undefined || body.includes(rule.bodyContains)),
  );
}

function batchOf(path: string, body: string): Batch | null {
  if (!path.endsWith("/append-events")) return null;
  try {
    const parsed = JSON.parse(body) as {
      batch_key: string;
      events: { source_sequence: number }[];
    };
    const events: Record<number, string> = {};
    for (const event of parsed.events) {
      events[event.source_sequence] = new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(event))
        .digest("hex");
    }
    return { key: parsed.batch_key, events };
  } catch {
    return null;
  }
}

function s3Error(): Response {
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>injected by the D2 gate</Message></Error>',
    { status: 500, headers: { "content-type": "application/xml" } },
  );
}

async function proxy(upstream: Upstream, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  const bytes =
    request.method === "GET" || request.method === "HEAD"
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());
  // Only gateway bodies are JSON worth reading; object bodies can be large
  // binary and are matched by key alone.
  const body = upstream === "gateway" ? new TextDecoder().decode(bytes) : "";
  const rule = matching(upstream, request.method, path, body);
  if (rule) rule.fired++;
  const entry: Entry = {
    at: new Date().toISOString(),
    batch: upstream === "gateway" ? batchOf(url.pathname, body) : null,
    bodyBytes: bytes.byteLength,
    corrupted: false,
    forwardedAt: null,
    index: received++,
    method: request.method,
    path,
    rule: rule?.id ?? null,
    sessionId:
      SESSION_IN_BODY.exec(body)?.[1] ??
      SESSION_IN_PATH.exec(path)?.[1] ??
      null,
    status: 0,
    upstream,
    upstreamStatus: null,
  };
  log.push(entry);
  if (LOG_MAX > 0 && log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  if (rule?.action === "delay") await Bun.sleep(rule.delayMs ?? 0);
  if (rule?.action === "hold") {
    const gate = released.get(rule.id) ?? Promise.resolve();
    await (rule.delayMs === undefined
      ? gate
      : Promise.race([gate, Bun.sleep(rule.delayMs)]));
  }
  if (rule?.action === "fail") {
    entry.status = 500;
    return s3Error();
  }
  const headers = new Headers(request.headers);
  for (const name of HOP_HEADERS) headers.delete(name);
  // S3 signs the host header; LocalStack does not check signatures, and the
  // gateway ignores it, so the upstream's own name is what goes out.
  entry.forwardedAt = new Date().toISOString();
  const response = await fetch(`${UPSTREAMS[upstream].target}${path}`, {
    method: request.method,
    headers,
    ...(bytes.byteLength > 0 ? { body: bytes } : {}),
    redirect: "manual",
  });
  entry.upstreamStatus = response.status;
  if (rule?.action === "lose_response") {
    await response.arrayBuffer();
    entry.status = 502;
    return new Response("bad gateway (injected by the D2 gate)", {
      status: 502,
    });
  }
  entry.status = response.status;
  // fetch has already decoded the body, so its length and coding no longer
  // describe what is sent on.
  const out = new Headers(response.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  if (rule?.action === "corrupt") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const at = bytes.byteLength >> 1;
    if (bytes.byteLength > 0 && response.ok) {
      bytes[at] = (bytes[at] ?? 0) ^ 0xff;
      entry.corrupted = true;
    }
    return new Response(bytes, { headers: out, status: response.status });
  }
  return new Response(response.body, {
    headers: out,
    status: response.status,
  });
}

for (const upstream of Object.keys(UPSTREAMS) as Upstream[]) {
  Bun.serve({
    hostname: "0.0.0.0",
    idleTimeout: 255,
    port: UPSTREAMS[upstream].listen,
    fetch: (request) => proxy(upstream, request),
  });
}

Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.CHAOS_CONTROL_PORT ?? "8099"),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/rules" && request.method === "POST") {
      const rule = (await request.json()) as Omit<Rule, "fired" | "id">;
      const armed: Rule = { ...rule, fired: 0, id: crypto.randomUUID() };
      rules.push(armed);
      if (armed.action === "hold") {
        released.set(
          armed.id,
          new Promise((release) => gates.set(armed.id, release)),
        );
      }
      return Response.json(armed);
    }
    if (url.pathname === "/rules" && request.method === "GET") {
      return Response.json(rules);
    }
    const release = /^\/rules\/([^/]+)\/release$/.exec(url.pathname);
    if (release && request.method === "POST") {
      const open = gates.get(release[1] ?? "");
      open?.();
      return new Response(null, { status: open ? 204 : 404 });
    }
    if (url.pathname.startsWith("/rules/") && request.method === "DELETE") {
      const id = url.pathname.slice("/rules/".length);
      // Nothing stays held by a rule that is gone.
      gates.get(id)?.();
      const at = rules.findIndex((rule) => rule.id === id);
      const [removed] = at < 0 ? [] : rules.splice(at, 1);
      return Response.json(removed ?? null, { status: removed ? 200 : 404 });
    }
    if (url.pathname === "/log") {
      const session = url.searchParams.get("session");
      const since = Number(url.searchParams.get("since") ?? "0");
      return Response.json(
        log.filter(
          (entry) =>
            entry.index >= since &&
            (session === null || entry.sessionId === session),
        ),
      );
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(JSON.stringify({ msg: "Gate chaos proxy listening", UPSTREAMS }));
process.on("SIGTERM", () => process.exit(0));
