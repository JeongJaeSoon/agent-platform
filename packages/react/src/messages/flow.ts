/** Wording shared by every multi-step flow: the funnel and its stepper. */
export const flowKo = {
  "flow.stepCompleted": "완료",
  "flow.reset":
    "이어 하던 입력이 지금 화면과 맞지 않아 첫 단계부터 다시 시작합니다.",
  "flow.reset.dismiss": "닫기",
} as const;

export const flowEn: Record<keyof typeof flowKo, string> = {
  "flow.stepCompleted": "completed",
  "flow.reset":
    "Your earlier input no longer fits this form, so it starts again from the first step.",
  "flow.reset.dismiss": "Dismiss",
};
