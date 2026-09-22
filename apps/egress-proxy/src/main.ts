import { egressProxyConfigFromEnv } from "./config.ts";
import { createProxyLogger } from "./logger.ts";
import { type EgressProxyServer, startEgressProxy } from "./proxy.ts";

/**
 * The only container on the worker network with a route off it. Workers
 * reach it through `HTTP_PROXY`/`HTTPS_PROXY`; everything it will not
 * forward is unreachable from a worker, because nothing else is.
 */
export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<EgressProxyServer> {
  const config = egressProxyConfigFromEnv(environment);
  return await startEgressProxy({
    hostname: config.hostname,
    logger: createProxyLogger(config.logLevel),
    policy: { allow: config.allow, allowPrivate: config.allowPrivate },
    port: config.port,
  });
}

if (import.meta.main) {
  const server = await main();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.stop();
      process.exit(0);
    });
  }
}
