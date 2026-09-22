/**
 * A three-line logger instead of `@agent-platform/observability`.
 *
 * The proxy has to boot from a bare `oven/bun` image with only its own
 * directory mounted — no workspace, no `node_modules` — so it carries no
 * workspace dependency. The record shape matches the platform logger's so
 * the lines still parse the same way.
 */

export const PROXY_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type ProxyLogLevel = (typeof PROXY_LOG_LEVELS)[number];

export type ProxyLogFields = Readonly<Record<string, unknown>>;

export type ProxyLogger = {
  debug(message: string, fields?: ProxyLogFields): void;
  error(message: string, fields?: ProxyLogFields): void;
  info(message: string, fields?: ProxyLogFields): void;
  warn(message: string, fields?: ProxyLogFields): void;
};

const rank: Readonly<Record<ProxyLogLevel, number>> = {
  debug: 10,
  error: 40,
  info: 20,
  warn: 30,
};

export function resolveProxyLogLevel(value: string | undefined): ProxyLogLevel {
  const normalized = value?.toLowerCase();
  return (PROXY_LOG_LEVELS as readonly string[]).includes(normalized ?? "")
    ? (normalized as ProxyLogLevel)
    : "info";
}

export function createProxyLogger(
  level: ProxyLogLevel = "info",
  write: (line: string) => void = (line) => {
    console.log(line);
  },
): ProxyLogger {
  const emit =
    (at: ProxyLogLevel) => (message: string, fields?: ProxyLogFields) => {
      if (rank[at] < rank[level]) return;
      write(
        JSON.stringify({
          level: at,
          message,
          timestamp: new Date().toISOString(),
          ...(fields === undefined ? {} : { fields }),
        }),
      );
    };
  return {
    debug: emit("debug"),
    error: emit("error"),
    info: emit("info"),
    warn: emit("warn"),
  };
}
