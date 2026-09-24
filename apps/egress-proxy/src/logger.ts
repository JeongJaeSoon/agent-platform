import { sanitizeFields, sanitizeText } from "./redaction.ts";

/**
 * A small logger instead of `@agent-platform/observability`: the proxy's
 * image copies only its own directory and installs nothing
 * (tests/images.test.ts), so it carries no workspace dependency. It masks by
 * the platform's rules all the same (`./redaction.ts`, 94S-386), and the
 * record shape matches the platform logger's so the lines parse the same way.
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
          message: sanitizeText(message),
          timestamp: new Date().toISOString(),
          ...(fields === undefined ? {} : { fields: sanitizeFields(fields) }),
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
