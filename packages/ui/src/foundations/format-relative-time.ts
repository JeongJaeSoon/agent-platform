import type { TimestampLocale } from "./format-timestamp.ts";

/*
 * Same fixed Asia/Seoul zone as format-timestamp.ts, for the same reason;
 * "today" and "yesterday" are calendar days in that zone. Intl only supplies
 * numeric fields and every pattern is assembled here, so the output is the
 * same on macOS and the CI runner.
 */
const SEOUL_OFFSET = "GMT+9";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

// The v4 console's catalog (Console.dc.html L979, L1018-1021), with the
// future and the waited time added in the same voice.
const PHRASES: Record<
  TimestampLocale,
  {
    readonly now: string;
    readonly minutes: (n: number) => string;
    readonly hours: (n: number) => string;
    readonly yesterday: (time: string) => string;
    readonly inMinutes: (n: number) => string;
    readonly inHours: (n: number) => string;
    readonly tomorrow: (time: string) => string;
    readonly waited: Record<"minute" | "hour" | "day", (n: number) => string>;
  }
> = {
  ko: {
    now: "방금",
    minutes: (n) => `${n}분 전`,
    hours: (n) => `${n}시간 전`,
    yesterday: (time) => `어제 ${time}`,
    inMinutes: (n) => `${n}분 후`,
    inHours: (n) => `${n}시간 후`,
    tomorrow: (time) => `내일 ${time}`,
    waited: {
      minute: (n) => `${n}분`,
      hour: (n) => `${n}시간`,
      day: (n) => `${n}일`,
    },
  },
  ja: {
    now: "たった今",
    minutes: (n) => `${n} 分前`,
    hours: (n) => `${n} 時間前`,
    yesterday: (time) => `昨日 ${time}`,
    inMinutes: (n) => `${n} 分後`,
    inHours: (n) => `${n} 時間後`,
    tomorrow: (time) => `明日 ${time}`,
    waited: {
      minute: (n) => `${n}分`,
      hour: (n) => `${n}時間`,
      day: (n) => `${n}日`,
    },
  },
  en: {
    now: "Just now",
    minutes: (n) => `${n} min ago`,
    hours: (n) => `${n} hr ago`,
    yesterday: (time) => `Yesterday ${time}`,
    inMinutes: (n) => `in ${n} min`,
    inHours: (n) => `in ${n} hr`,
    tomorrow: (time) => `Tomorrow ${time}`,
    waited: {
      minute: (n) => `${n} min`,
      hour: (n) => `${n} hr`,
      day: (n) => (n === 1 ? "1 day" : `${n} days`),
    },
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
 * When something happens, by the calendar: "방금", "N분 전", "N시간 전" (same
 * day), "어제 HH:MM", "M/D", or "YYYY/M/D" in another year. With `future`,
 * a time ahead of `now` reads "N분 후", "N시간 후" (same day), "내일 HH:MM"
 * or the same dates; under a minute either way stays "방금". Without it, a
 * time ahead reads "방금": a past-only value (created_at, last_event_at) is
 * ahead only because `now` is a minute tick behind or the clocks differ. An
 * unparseable string comes back unchanged, as formatTimestamp does. How long
 * something has lasted is formatElapsed's. With `inSentence`, English
 * starts lower-case ("Expires tomorrow 15:14"); ko and ja have no case.
 */
export function formatRelativeTime(
  value: string | Date,
  locale: TimestampLocale = "ko",
  now: number | Date = Date.now(),
  options: {
    readonly future?: boolean | undefined;
    readonly inSentence?: boolean | undefined;
  } = {},
): string {
  const phrase = relativePhrase(value, locale, now, options.future);
  const parsed = !Number.isNaN(toDate(value).getTime());
  return options.inSentence && locale === "en" && parsed
    ? phrase.charAt(0).toLowerCase() + phrase.slice(1)
    : phrase;
}

function relativePhrase(
  value: string | Date,
  locale: TimestampLocale,
  now: number | Date,
  allowFuture: boolean | undefined,
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const phrases = PHRASES[locale];
  const delta = new Date(now).getTime() - date.getTime();
  const future = delta < 0;
  if (future && !allowFuture) return phrases.now;
  const elapsed = Math.abs(delta);
  if (elapsed < MINUTE) return phrases.now;
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return future ? phrases.inMinutes(minutes) : phrases.minutes(minutes);
  }

  const then = seoulFields(date);
  const today = seoulFields(new Date(now));
  const days = calendarDay(today) - calendarDay(then);
  if (days === 0) {
    const hours = Math.floor(elapsed / HOUR);
    return future ? phrases.inHours(hours) : phrases.hours(hours);
  }
  const time = `${then.hour}:${then.minute}`;
  if (days === 1) return phrases.yesterday(time);
  if (days === -1) return phrases.tomorrow(time);
  if (then.year === today.year) return `${then.month}/${then.day}`;
  return `${then.year}/${then.month}/${then.day}`;
}

/**
 * How long since `since`, in its largest whole unit, rounded down: minutes
 * under an hour, hours from 60 minutes, days from 24 hours ("12분", "2 hr",
 * "3日"). A start ahead of `now` reads as 0 minutes; an unparseable string
 * comes back unchanged.
 */
export function formatElapsed(
  since: string | Date,
  locale: TimestampLocale = "ko",
  now: number | Date = Date.now(),
): string {
  const date = toDate(since);
  if (Number.isNaN(date.getTime())) return String(since);

  const { waited } = PHRASES[locale];
  const elapsed = Math.max(0, new Date(now).getTime() - date.getTime());
  if (elapsed >= DAY) return waited.day(Math.floor(elapsed / DAY));
  if (elapsed >= HOUR) return waited.hour(Math.floor(elapsed / HOUR));
  return waited.minute(Math.floor(elapsed / MINUTE));
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
