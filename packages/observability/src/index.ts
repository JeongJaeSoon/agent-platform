import { AsyncLocalStorage } from "node:async_hooks";

import { type LogFields, sanitizeFields, sanitizeText } from "./redaction.ts";

export {
  type LogFields,
  REDACTED,
  sanitizeFields,
  sanitizeText,
} from "./redaction.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ObservabilityContext {
  readonly session_id?: string;
  readonly turn_id?: string | number;
  readonly pod_id?: string;
  readonly request_id?: string;
  readonly trace_id?: string;
}

export interface LogRecord extends ObservabilityContext {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields?: LogFields;
}

export interface LogSink {
  write(record: LogRecord): void | Promise<void>;
}

export interface LoggerOptions {
  readonly level?: LogLevel | string;
  readonly sinks?: readonly LogSink[];
  readonly includeMessageBodies?: boolean;
  readonly now?: () => Date;
}

const levelRank: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isLogLevel(value: string | undefined): value is LogLevel {
  return (
    value !== undefined && (LOG_LEVELS as readonly string[]).includes(value)
  );
}

export function resolveLogLevel(value = process.env.LOG_LEVEL): LogLevel {
  const normalized = value?.toLowerCase();
  return isLogLevel(normalized) ? normalized : "info";
}

/**
 * LOG_LEVEL as a process takes it at startup: unset or empty is `info`, and a
 * value that names no level stops the process instead of quietly logging at
 * `info` (94S-389).
 */
export function logLevelFromEnv(value: string | undefined): LogLevel {
  if (value === undefined || value.trim() === "") return "info";
  const normalized = value.trim().toLowerCase();
  if (!isLogLevel(normalized)) {
    throw new Error(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join("|")}, got ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}

function sanitizeException(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return sanitizeText(value);
}

export class MemoryLogSink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

export class StdoutLogSink implements LogSink {
  write(record: LogRecord): void {
    console.log(JSON.stringify(record));
  }
}

export class StructuredLogger {
  private readonly context = new AsyncLocalStorage<ObservabilityContext>();
  private readonly includeMessageBodies: boolean;
  private readonly level: LogLevel;
  private readonly now: () => Date;
  private readonly sinks: readonly LogSink[];

  constructor(options: LoggerOptions = {}) {
    this.level = resolveLogLevel(options.level);
    this.sinks = options.sinks ?? [new StdoutLogSink()];
    this.includeMessageBodies = options.includeMessageBodies ?? false;
    this.now = options.now ?? (() => new Date());
  }

  getContext(): ObservabilityContext {
    return this.context.getStore() ?? {};
  }

  withContext<T>(context: ObservabilityContext, run: () => T): T {
    return this.context.run({ ...this.getContext(), ...context }, run);
  }

  debug(message: string, fields?: LogFields): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.log("error", message, fields);
  }

  log(level: LogLevel, message: string, fields?: LogFields): void {
    if (levelRank[level] < levelRank[this.level]) {
      return;
    }

    let record: LogRecord;
    try {
      const sanitizedFields = fields
        ? sanitizeFields(fields, this.includeMessageBodies)
        : undefined;
      record = {
        timestamp: this.now().toISOString(),
        level,
        message: sanitizeText(message),
        ...this.getContext(),
        ...(sanitizedFields && Object.keys(sanitizedFields).length > 0
          ? { fields: sanitizedFields }
          : {}),
      };
    } catch {
      return;
    }

    for (const sink of this.sinks) {
      try {
        const result = sink.write(record);
        if (result instanceof Promise) {
          void result.catch(() => undefined);
        }
      } catch {
        // Logging must never make a worker or API request fail.
      }
    }
  }
}

export function createLogger(options: LoggerOptions = {}): StructuredLogger {
  return new StructuredLogger(options);
}

export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export interface Metrics {
  counter(name: string, value?: number, labels?: MetricLabels): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  histogram(name: string, value: number, labels?: MetricLabels): void;
}

export interface MetricSample {
  readonly name: string;
  readonly value: number;
  readonly labels: MetricLabels;
}

function metricKey(name: string, labels: MetricLabels): string {
  return `${name}:${JSON.stringify(Object.entries(labels).sort())}`;
}

export class InMemoryMetrics implements Metrics {
  readonly counters = new Map<string, MetricSample>();
  readonly gauges = new Map<string, MetricSample>();
  readonly histograms: MetricSample[] = [];

  counter(name: string, value = 1, labels: MetricLabels = {}): void {
    const key = metricKey(name, labels);
    const existing = this.counters.get(key);
    this.counters.set(key, {
      name,
      value: (existing?.value ?? 0) + value,
      labels,
    });
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.gauges.set(metricKey(name, labels), { name, value, labels });
  }

  histogram(name: string, value: number, labels: MetricLabels = {}): void {
    this.histograms.push({ name, value, labels });
  }
}

export class NoopMetrics implements Metrics {
  counter(_name: string, _value?: number, _labels?: MetricLabels): void {}

  gauge(_name: string, _value: number, _labels?: MetricLabels): void {}

  histogram(_name: string, _value: number, _labels?: MetricLabels): void {}
}

export interface Span {
  end(attributes?: LogFields): void;
  recordException(error: unknown): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: LogFields): Span;
}

export interface RecordedSpan {
  readonly name: string;
  readonly startedAt: string;
  readonly attributes: LogFields;
  readonly exceptions: readonly string[];
  readonly endedAt?: string;
}

export class InMemoryTracer implements Tracer {
  readonly spans: RecordedSpan[] = [];

  startSpan(name: string, attributes: LogFields = {}): Span {
    const span: {
      name: string;
      startedAt: string;
      attributes: LogFields;
      exceptions: string[];
      endedAt?: string;
    } = {
      name,
      startedAt: new Date().toISOString(),
      attributes: sanitizeFields(attributes),
      exceptions: [],
    };
    this.spans.push(span);

    return {
      end: (endAttributes = {}) => {
        Object.assign(span.attributes, sanitizeFields(endAttributes));
        span.endedAt = new Date().toISOString();
      },
      recordException: (error) => {
        span.exceptions.push(sanitizeException(error));
      },
    };
  }
}

export class NoopTracer implements Tracer {
  startSpan(_name: string, _attributes?: LogFields): Span {
    return { end: () => undefined, recordException: () => undefined };
  }
}

export interface Observability {
  readonly logger: StructuredLogger;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
  withSpan<T>(name: string, run: () => T, attributes?: LogFields): T;
}

export function createObservability(
  logger: StructuredLogger = createLogger(),
  metrics: Metrics = new NoopMetrics(),
  tracer: Tracer = new NoopTracer(),
): Observability {
  return {
    logger,
    metrics,
    tracer,
    withSpan: <T>(
      name: string,
      run: () => T,
      attributes: LogFields = {},
    ): T => {
      const span = tracer.startSpan(name, attributes);
      const traceId = logger.getContext().trace_id ?? crypto.randomUUID();
      try {
        const result = logger.withContext({ trace_id: traceId }, run);
        if (result instanceof Promise) {
          return result.then(
            (value) => {
              span.end();
              return value;
            },
            (error: unknown) => {
              span.recordException(error);
              span.end();
              throw error;
            },
          ) as T;
        }
        span.end();
        return result;
      } catch (error) {
        span.recordException(error);
        span.end();
        throw error;
      }
    },
  };
}
