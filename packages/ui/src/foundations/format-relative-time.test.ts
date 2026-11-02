import { describe, expect, test } from "bun:test";

import {
  formatElapsed,
  formatExactTime,
  formatRelativeTime,
} from "./format-relative-time.ts";
import type { TimestampLocale } from "./format-timestamp.ts";

// 2026-10-24 15:14:02 in Seoul.
const NOW = Date.parse("2026-10-24T15:14:02+09:00");

const cases: [
  label: string,
  at: string,
  now: number,
  expected: Record<TimestampLocale, string>,
][] = [
  [
    "59초 전은 방금",
    "2026-10-24T15:13:03+09:00",
    NOW,
    { ko: "방금", ja: "たった今", en: "Just now" },
  ],
  [
    "60초 전은 1분 전",
    "2026-10-24T15:13:02+09:00",
    NOW,
    { ko: "1분 전", ja: "1 分前", en: "1 min ago" },
  ],
  [
    "59분 59초 전은 59분 전",
    "2026-10-24T14:14:03+09:00",
    NOW,
    { ko: "59분 전", ja: "59 分前", en: "59 min ago" },
  ],
  [
    "60분 전은 1시간 전",
    "2026-10-24T14:14:02+09:00",
    NOW,
    { ko: "1시간 전", ja: "1 時間前", en: "1 hr ago" },
  ],
  [
    "같은 날 자정 직후는 N시간 전",
    "2026-10-24T00:00:00+09:00",
    NOW,
    { ko: "15시간 전", ja: "15 時間前", en: "15 hr ago" },
  ],
  [
    "자정 직전은 어제 HH:MM",
    "2026-10-23T23:59:59+09:00",
    NOW,
    { ko: "어제 23:59", ja: "昨日 23:59", en: "Yesterday 23:59" },
  ],
  [
    "어제 자정은 h23으로 00:00",
    "2026-10-23T00:00:00+09:00",
    NOW,
    { ko: "어제 00:00", ja: "昨日 00:00", en: "Yesterday 00:00" },
  ],
  [
    "그제는 M/D",
    "2026-10-22T23:59:59+09:00",
    NOW,
    { ko: "10/22", ja: "10/22", en: "10/22" },
  ],
  [
    "자정을 넘긴 직후에도 60분 미만이면 N분 전",
    "2026-10-23T23:50:00+09:00",
    Date.parse("2026-10-24T00:10:00+09:00"),
    { ko: "20분 전", ja: "20 分前", en: "20 min ago" },
  ],
  [
    "UTC로는 같은 날이어도 서울 달력으로 어제",
    // 2026-10-23T14:30Z (Seoul 23:30 on the 23rd) vs 2026-10-23T16:00Z (Seoul 01:00 on the 24th)
    "2026-10-23T14:30:00Z",
    Date.parse("2026-10-23T16:00:00Z"),
    { ko: "어제 23:30", ja: "昨日 23:30", en: "Yesterday 23:30" },
  ],
  [
    "UTC로는 어제여도 서울 달력으로 오늘",
    // 2026-10-23T15:30Z is Seoul 00:30 on the 24th.
    "2026-10-23T15:30:00Z",
    Date.parse("2026-10-24T03:00:00Z"),
    { ko: "11시간 전", ja: "11 時間前", en: "11 hr ago" },
  ],
  [
    "연초에 본 연말 마지막 날은 어제",
    "2026-12-31T22:00:00+09:00",
    Date.parse("2027-01-01T09:00:00+09:00"),
    { ko: "어제 22:00", ja: "昨日 22:00", en: "Yesterday 22:00" },
  ],
  [
    "연초에 본 지난해는 YYYY/M/D",
    "2026-12-30T22:00:00+09:00",
    Date.parse("2027-01-01T09:00:00+09:00"),
    { ko: "2026/12/30", ja: "2026/12/30", en: "2026/12/30" },
  ],
  [
    "같은 해 연초는 M/D",
    "2026-01-01T00:00:00+09:00",
    NOW,
    { ko: "1/1", ja: "1/1", en: "1/1" },
  ],
  [
    "1분 안쪽의 미래(시계 차이)는 방금",
    "2026-10-24T15:14:59+09:00",
    NOW,
    { ko: "방금", ja: "たった今", en: "Just now" },
  ],
  [
    "6분 뒤는 N분 후",
    "2026-10-24T15:20:02+09:00",
    NOW,
    { ko: "6분 후", ja: "6 分後", en: "in 6 min" },
  ],
  [
    "1시간 뒤는 1시간 후",
    "2026-10-24T16:14:02+09:00",
    NOW,
    { ko: "1시간 후", ja: "1 時間後", en: "in 1 hr" },
  ],
  [
    "내일은 내일 HH:MM",
    "2026-10-25T09:30:00+09:00",
    NOW,
    { ko: "내일 09:30", ja: "明日 09:30", en: "Tomorrow 09:30" },
  ],
  [
    "UTC로는 같은 날이어도 서울 달력으로 내일",
    // 2026-10-24T14:30Z is Seoul 23:30 on the 24th; 16:00Z is 01:00 on the 25th.
    "2026-10-24T16:00:00Z",
    Date.parse("2026-10-24T14:30:00Z"),
    { ko: "내일 01:00", ja: "明日 01:00", en: "Tomorrow 01:00" },
  ],
  [
    "연말에 본 새해 첫날은 내일",
    "2027-01-01T09:00:00+09:00",
    Date.parse("2026-12-31T22:00:00+09:00"),
    { ko: "내일 09:00", ja: "明日 09:00", en: "Tomorrow 09:00" },
  ],
  [
    "3일 뒤는 M/D",
    "2026-10-27T15:14:02+09:00",
    NOW,
    { ko: "10/27", ja: "10/27", en: "10/27" },
  ],
  [
    "다음 해는 YYYY/M/D",
    "2027-01-03T10:00:00+09:00",
    NOW,
    { ko: "2027/1/3", ja: "2027/1/3", en: "2027/1/3" },
  ],
];

describe("formatRelativeTime", () => {
  for (const [label, at, now, expected] of cases) {
    test(label, () => {
      for (const locale of ["ko", "ja", "en"] as const) {
        expect(formatRelativeTime(at, locale, now)).toBe(expected[locale]);
      }
    });
  }

  test("Date 입력과 숫자 now를 받고, 기본 locale은 ko", () => {
    expect(
      formatRelativeTime(
        new Date("2026-10-24T13:00:00+09:00"),
        undefined,
        new Date(NOW),
      ),
    ).toBe("2시간 전");
  });

  test("해석할 수 없는 입력은 그대로 돌려준다", () => {
    for (const locale of ["ko", "ja", "en"] as const) {
      expect(formatRelativeTime("not-a-date", locale, NOW)).toBe("not-a-date");
      expect(formatExactTime("not-a-date", locale)).toBe("not-a-date");
    }
  });
});

describe("formatExactTime", () => {
  test("세 언어에서 서울 시각과 GMT+9를 고정 문자열로 쓴다", () => {
    const at = "2026-10-24T06:14:02Z";
    expect(formatExactTime(at, "ko")).toBe("2026년 10월 24일 15:14:02 GMT+9");
    expect(formatExactTime(at, "ja")).toBe("2026年10月24日 15:14:02 GMT+9");
    expect(formatExactTime(at, "en")).toBe("October 24, 2026, 15:14:02 GMT+9");
  });

  test("자정은 h23으로 00시다", () => {
    expect(formatExactTime("2026-12-31T15:00:00Z", "ko")).toBe(
      "2027년 1월 1일 00:00:00 GMT+9",
    );
  });
});

describe("formatElapsed", () => {
  const MIN = 60_000;
  const cases: [label: string, ago: number, Record<TimestampLocale, string>][] =
    [
      [
        "59분 59초는 59분",
        60 * MIN - 1000,
        { ko: "59분", ja: "59分", en: "59 min" },
      ],
      ["60분부터 시간", 60 * MIN, { ko: "1시간", ja: "1時間", en: "1 hr" }],
      ["120분은 2시간", 120 * MIN, { ko: "2시간", ja: "2時間", en: "2 hr" }],
      [
        "23시간 59분은 내림해 23시간",
        24 * 60 * MIN - MIN,
        { ko: "23시간", ja: "23時間", en: "23 hr" },
      ],
      ["24시간부터 일", 24 * 60 * MIN, { ko: "1일", ja: "1日", en: "1 day" }],
      ["3일", 3 * 24 * 60 * MIN, { ko: "3일", ja: "3日", en: "3 days" }],
      ["1분 미만은 0분", 59_000, { ko: "0분", ja: "0分", en: "0 min" }],
      ["미래 시작은 0분", -5 * MIN, { ko: "0분", ja: "0分", en: "0 min" }],
    ];
  for (const [label, ago, expected] of cases) {
    test(label, () => {
      const since = new Date(NOW - ago).toISOString();
      for (const locale of ["ko", "ja", "en"] as const) {
        expect(formatElapsed(since, locale, NOW)).toBe(expected[locale]);
      }
    });
  }

  test("해석할 수 없는 입력은 그대로, 기본 locale은 ko", () => {
    expect(formatElapsed("not-a-date", "en", NOW)).toBe("not-a-date");
    expect(formatElapsed(new Date(NOW - 12 * MIN), undefined, NOW)).toBe(
      "12분",
    );
  });
});
