/**
 * What a form shows for a failed check, one key per kind of zod issue
 * (forms/issues.ts). The contract's own English messages never reach the page.
 */
export const formsKo = {
  "form.error.required": "필수 항목입니다.",
  "form.error.tooShort": "{min}자 이상 입력하세요.",
  "form.error.tooLong": "{max}자 이하로 입력하세요.",
  "form.error.tooFew": "{min}개 이상 넣으세요.",
  "form.error.tooMany": "{max}개 이하로 넣으세요.",
  "form.error.tooSmall": "{min} 이상이어야 합니다.",
  "form.error.tooBig": "{max} 이하여야 합니다.",
  "form.error.email": "이메일 주소 형식이 아닙니다.",
  "form.error.format": "형식이 맞지 않습니다.",
  "form.error.choice": "목록에 있는 값을 고르세요.",
  "form.error.invalid": "값을 확인하세요.",
};

export const formsEn: Record<keyof typeof formsKo, string> = {
  "form.error.required": "This is required.",
  "form.error.tooShort": "Enter at least {min} characters.",
  "form.error.tooLong": "Enter at most {max} characters.",
  "form.error.tooFew": "Add at least {min}.",
  "form.error.tooMany": "Add at most {max}.",
  "form.error.tooSmall": "Must be at least {min}.",
  "form.error.tooBig": "Must be at most {max}.",
  "form.error.email": "Enter an email address.",
  "form.error.format": "The format is not valid.",
  "form.error.choice": "Choose one of the options.",
  "form.error.invalid": "Check this value.",
};

export const formsJa: Record<keyof typeof formsKo, string> = {
  "form.error.required": "必須項目です。",
  "form.error.tooShort": "{min}文字以上で入力してください。",
  "form.error.tooLong": "{max}文字以内で入力してください。",
  "form.error.tooFew": "{min}個以上追加してください。",
  "form.error.tooMany": "{max}個以内にしてください。",
  "form.error.tooSmall": "{min}以上の値にしてください。",
  "form.error.tooBig": "{max}以下の値にしてください。",
  "form.error.email": "メールアドレスの形式で入力してください。",
  "form.error.format": "形式が正しくありません。",
  "form.error.choice": "一覧から選択してください。",
  "form.error.invalid": "値を確認してください。",
};
