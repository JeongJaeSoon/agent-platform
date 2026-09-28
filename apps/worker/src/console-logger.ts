import {
  LOG_LEVELS,
  type LogLevel,
  resolveLogLevel,
  sanitizeFields,
  sanitizeText,
} from "@agent-platform/observability";

import type { WorkerLogger } from "./worker-host.ts";

/**
 * One JSON object per line: `timestamp`, `level`, `event`, then the fields,
 * masked by the platform's log rules. Keys that name a message
 * body are kept: the worker logs no bodies, and the rule would drop
 * `input_id`.
 */
export function createConsoleLogger(
  options: {
    level?: string;
    now?: () => Date;
    write?: (line: string) => void;
  } = {},
): WorkerLogger {
  const threshold = LOG_LEVELS.indexOf(resolveLogLevel(options.level));
  const now = options.now ?? (() => new Date());
  const write = options.write ?? ((line: string) => console.log(line));
  const emit =
    (level: LogLevel) =>
    (event: string, fields?: Record<string, unknown>): void => {
      if (LOG_LEVELS.indexOf(level) < threshold) return;
      const head = {
        timestamp: now().toISOString(),
        level,
        event: sanitizeText(event),
      };
      // Assigned again after the fields, so a field named `level` or
      // `event` cannot replace the record's own.
      write(
        JSON.stringify(
          Object.assign({ ...head }, sanitizeFields(fields ?? {}, true), head),
        ),
      );
    };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const consoleLogger: WorkerLogger = createConsoleLogger();
