import { DEFAULT_CREDENTIAL_PORT } from "./credential.ts";
import { DEFAULT_PROXY_PORT } from "./proxy.ts";
import { reportedSourceDigest, sourceDigest } from "./source.ts";

export type HealthVerdict =
  | { healthy: true }
  | { healthy: false; reason: string };

/**
 * The compose healthcheck: the proxy answers, and it runs the source that is
 * on disk now. The second half catches a checkout that moved under a running
 * proxy (see `sourceDigest`). With credential routes configured, their
 * listener has to answer too: workers reach their provider and repository
 * only through it (94S-252).
 */
export async function checkHealth(options: {
  dir: string;
  url: string;
  credentialUrl?: string;
}): Promise<HealthVerdict> {
  const proxy = await probe(options.url, "/healthz");
  if (!proxy.ok) return { healthy: false, reason: proxy.reason };
  if (options.credentialUrl !== undefined) {
    const credential = await probe(
      options.credentialUrl,
      "credential /healthz",
    );
    if (!credential.ok) return { healthy: false, reason: credential.reason };
  }
  const running = reportedSourceDigest(proxy.body);
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

async function probe(
  url: string,
  label: string,
): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) {
      return { ok: false, reason: `${label} answered ${response.status}` };
    }
    return { ok: true, body: await response.text() };
  } catch (error) {
    return { ok: false, reason: `${label} failed: ${String(error)}` };
  }
}

if (import.meta.main) {
  const port = process.env.EGRESS_PROXY_PORT ?? String(DEFAULT_PROXY_PORT);
  const credentialPort =
    process.env.EGRESS_CREDENTIAL_PORT ?? String(DEFAULT_CREDENTIAL_PORT);
  const verdict = await checkHealth({
    dir: import.meta.dir,
    url: `http://127.0.0.1:${port}/healthz`,
    // The same switch main.ts uses to start the credential routes.
    ...(process.env.EGRESS_AUTHORIZER_URL
      ? { credentialUrl: `http://127.0.0.1:${credentialPort}/healthz` }
      : {}),
  });
  if (!verdict.healthy) {
    console.error(verdict.reason);
    process.exit(1);
  }
}
