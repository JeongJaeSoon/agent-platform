/*
 * Fixed to Asia/Seoul: the product is Korean-facing and a pinned zone keeps
 * rendering identical on a CI runner and on a laptop. Swap this for the user's
 * profile timezone when 설정 gains one (I0 설정 화면).
 */
const FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Seoul",
});

export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return FORMATTER.format(parsed);
}
