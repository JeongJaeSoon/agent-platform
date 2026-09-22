/*
 * The zone is fixed to Asia/Seoul — the product is Korean-facing. Swap it for
 * the user's profile timezone when 설정 gains one (I0 설정 화면).
 *
 * The *pattern* is assembled by hand rather than left to `dateStyle: "short"`,
 * which is not stable across platforms: the same instant rendered
 * "26. 9. 21." on macOS and "2026. 9. 21." on the CI runner, and the snapshot
 * caught it. Only the field values come from Intl, so the zone conversion is
 * still the library's job.
 */
const PARTS = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  // h23, not `hour12: false`: some ICU builds render midnight as 24 otherwise.
  hourCycle: "h23",
});

export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;

  const parts = new Map(
    PARTS.formatToParts(parsed).map((part) => [part.type, part.value] as const),
  );
  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.get(type) ?? "";

  return `${at("year")}. ${at("month")}. ${at("day")}. ${at("hour")}:${at("minute")}`;
}
