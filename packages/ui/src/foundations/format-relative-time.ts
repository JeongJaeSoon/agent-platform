import type { TimestampLocale } from "./format-timestamp.ts";

/*
 * Same fixed Asia/Seoul zone as format-timestamp.ts, for the same reason;
 * "today" and "yesterday" are calendar days in that zone. Intl only supplies
 * numeric fields and every pattern is assembled here, so the output is the
 * same on macOS and the CI runner.
 */
const SEOUL_OFFSET = "GMT+9";

const FIELDS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// The v4 console's catalog (Console.dc.html L979, L1018-1021).
const PHRASES: Record<
  TimestampLocale,
  {
    readonly now: string;
    readonly minutes: (n: number) => string;
    readonly hours: (n: number) => string;
    readonly yesterday: (time: string) => string;
  }
> = {
  ko: {
    now: "방금",
    minutes: (n) => `${n}분 전`,
    hours: (n) => `${n}시간 전`,
    yesterday: (time) => `어제 ${time}`,
  },
  ja: {
    now: "たった今",
    minutes: (n) => `${n} 分前`,
    hours: (n) => `${n} 時間前`,
    yesterday: (time) => `昨日 ${time}`,
  },
  en: {
    now: "Just now",
    minutes: (n) => `${n} min ago`,
    hours: (n) => `${n} hr ago`,
    yesterday: (time) => `Yesterday ${time}`,
  },
};

interface SeoulFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
}

function seoulFields(date: Date): SeoulFields {
  const parts = new Map(
    FIELDS.formatToParts(date).map((part) => [part.type, part.value] as const),
  );
  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.get(type) ?? "";
  return {
    year: Number(at("year")),
    month: Number(at("month")),
    day: Number(at("day")),
    hour: at("hour"),
    minute: at("minute"),
    second: at("second"),
  };
}

function calendarDay({ year, month, day }: SeoulFields): number {
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function toDate(value: string | Date): Date {
  return typeof value === "string" ? new Date(value) : value;
}

/**
 * "방금", "N분 전", "N시간 전" (same day), "어제 HH:MM", "M/D", or "YYYY/M/D"
 * in another year. A time ahead of `now` (clock skew) reads as "방금"; an
 * unparseable string comes back unchanged, as formatTimestamp does.
 */
export function formatRelativeTime(
  value: string | Date,
  locale: TimestampLocale = "ko",
  now: number | Date = Date.now(),
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const phrases = PHRASES[locale];
  const elapsed = new Date(now).getTime() - date.getTime();
  if (elapsed < 60_000) return phrases.now;
  if (elapsed < 3_600_000) return phrases.minutes(Math.floor(elapsed / 60_000));

  const then = seoulFields(date);
  const today = seoulFields(new Date(now));
  const days = calendarDay(today) - calendarDay(then);
  if (days === 0) return phrases.hours(Math.floor(elapsed / 3_600_000));
  if (days === 1) return phrases.yesterday(`${then.hour}:${then.minute}`);
  if (then.year === today.year) return `${then.month}/${then.day}`;
  return `${then.year}/${then.month}/${then.day}`;
}

/** The exact instant with zone, e.g. "2026년 10월 24일 15:14:02 GMT+9". */
export function formatExactTime(
  value: string | Date,
  locale: TimestampLocale = "ko",
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const { year, month, day, hour, minute, second } = seoulFields(date);
  const time = `${hour}:${minute}:${second} ${SEOUL_OFFSET}`;
  switch (locale) {
    case "en":
      return `${MONTHS[month - 1]} ${day}, ${year}, ${time}`;
    case "ja":
      return `${year}年${month}月${day}日 ${time}`;
    default:
      return `${year}년 ${month}월 ${day}일 ${time}`;
  }
}
