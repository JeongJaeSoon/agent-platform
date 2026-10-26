export const usageKo = {
  "usage.duration.hours": "{h}시간 {m}분",
  "usage.duration.minutes": "{m}분",
  "usage.duration.seconds": "{s}초",
  "usage.kpi.estimated": "추정",
  "usage.kpi.costNote": "provider 청구액과 다를 수 있음",
};

export const usageEn: Record<keyof typeof usageKo, string> = {
  "usage.duration.hours": "{h}h {m}m",
  "usage.duration.minutes": "{m}m",
  "usage.duration.seconds": "{s}s",
  "usage.kpi.estimated": "Est.",
  "usage.kpi.costNote": "May differ from the provider's bill",
};

export const usageJa: Record<keyof typeof usageKo, string> = {
  "usage.duration.hours": "{h}時間{m}分",
  "usage.duration.minutes": "{m}分",
  "usage.duration.seconds": "{s}秒",
  "usage.kpi.estimated": "推定",
  "usage.kpi.costNote": "provider の請求額と異なる場合あり",
};
