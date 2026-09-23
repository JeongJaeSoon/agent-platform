import { DEFAULT_PROXY_PORT } from "./proxy.ts";
import { reportedSourceDigest, sourceDigest } from "./source.ts";

export type HealthVerdict =
  | { healthy: true }
  | { healthy: false; reason: string };

/**
 * The compose healthcheck: the proxy answers, and it runs the source that is
 * on disk now. The second half catches a checkout that moved under a running
 * proxy (see `sourceDigest`).
 */
export async function checkHealth(options: {
  dir: string;
  url: string;
}): Promise<HealthVerdict> {
  let body: string;
  try {
    const response = await fetch(options.url, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return { healthy: false, reason: `/healthz answered ${response.status}` };
    }
    body = await response.text();
  } catch (error) {
    return { healthy: false, reason: `/healthz failed: ${String(error)}` };
  }
  const running = reportedSourceDigest(body);
  if (running === null) {
    return { healthy: false, reason: "/healthz reported no source digest" };
  }
  const onDisk = sourceDigest(options.dir);
  if (running !== onDisk) {
    return {
      healthy: false,
      reason:
        `stale: the running proxy loaded source ${running.slice(0, 12)} but ` +
        `${options.dir} now holds ${onDisk.slice(0, 12)}; recreate the container`,
    };
  }
  return { healthy: true };
}

if (import.meta.main) {
  const port = process.env.EGRESS_PROXY_PORT ?? String(DEFAULT_PROXY_PORT);
  const verdict = await checkHealth({
    dir: import.meta.dir,
    url: `http://127.0.0.1:${port}/healthz`,
  });
  if (!verdict.healthy) {
    console.error(verdict.reason);
    process.exit(1);
  }
}
