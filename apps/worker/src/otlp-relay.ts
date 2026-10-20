import { createServer, request, type Server } from "node:http";

/**
 * Spike (OBS-SPIKE): the engine's OTLP exporter tunnels even plain http
 * through the proxy with CONNECT, which the egress proxy only lets TLS
 * through. The engine sends to this loopback relay instead (NO_PROXY), and
 * the relay sends each request on as absolute-form HTTP through the proxy,
 * so the collector stays behind the proxy's forward allowlist.
 */
export function startOtlpRelay(
  environment: NodeJS.ProcessEnv,
): Server | undefined {
  const upstream = environment.WORKER_OTLP_RELAY_UPSTREAM;
  const proxy = environment.HTTP_PROXY ?? environment.http_proxy;
  if (upstream === undefined || proxy === undefined) return undefined;
  const target = new URL(upstream);
  const via = new URL(proxy);
  const server = createServer((incoming, outgoing) => {
    const forwarded = request(
      {
        host: via.hostname,
        port: via.port,
        method: incoming.method,
        path: new URL(incoming.url ?? "/", target).toString(),
        headers: { ...incoming.headers, host: target.host },
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    forwarded.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(forwarded);
  });
  server.listen(4318, "127.0.0.1");
  server.unref();
  return server;
}
