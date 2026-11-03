import {
  type PendingQuestion,
  type QuestionAnswer,
  questionAnswerMismatch,
  SLACK_INTERACTION_ACTIONS,
  SLACK_QUESTION_VIEW_CALLBACK,
  type SlackInteractionValue,
  type SlackQuestionViewMetadata,
  type UserLocale,
} from "@werft-ai/contracts";

/** A request a session waits on that a person can settle in its thread. */
export type SlackPrompt =
  | {
      kind: "permission";
      sessionId: string;
      requestId: string;
      tool: string;
      input: unknown;
      expiresAt: string;
    }
  | {
      kind: "question";
      sessionId: string;
      requestId: string;
      questions: PendingQuestion[];
      expiresAt: string;
    }
  | {
      kind: "push";
      sessionId: string;
      requestId: string;
      repositoryId: string;
      targetBranch: string;
      gitCommit: string;
    };

/** How a request ended, as its card says once it is settled. */
export type SlackPromptResult =
  | "allowed"
  | "denied"
  | "answered"
  | "approved"
  | "rejected"
  | "closed";

type PromptCopy = {
  permissionTitle: string;
  questionTitle: string;
  pushTitle: string;
  tool: string;
  repository: string;
  branch: string;
  commit: string;
  allow: string;
  deny: string;
  approve: string;
  reject: string;
  answer: string;
  freeText: string;
  modalTitle: string;
  submit: string;
  cancel: string;
  freeTextLabel: string;
  pushConfirm: string;
  expires: string;
  link: string;
  answerRequired: string;
  /** `{who}` is the Slack mention of whoever settled it. */
  by: Record<Exclude<SlackPromptResult, "closed">, string>;
  /** Shown when the card is pressed after someone else settled it. */
  already: Record<SlackPromptResult, string>;
};

// Product copy: plain words, no internal module names.
export const SLACK_PROMPT_MESSAGES: Readonly<Record<UserLocale, PromptCopy>> = {
  ko: {
    permissionTitle: "도구 사용 허용이 필요해요",
    questionTitle: "답이 필요한 질문이 있어요",
    pushTitle: "push 승인이 필요해요",
    tool: "도구",
    repository: "저장소",
    branch: "브랜치",
    commit: "커밋",
    allow: "허용",
    deny: "거부",
    approve: "승인",
    reject: "거절",
    answer: "답하기",
    freeText: "직접 입력",
    modalTitle: "질문에 답하기",
    submit: "보내기",
    cancel: "취소",
    freeTextLabel: "직접 입력한 답",
    pushConfirm: "이 커밋을 브랜치에 push해요",
    expires: "답하지 않으면 {time}에 만료돼요",
    link: "웹에서 열기",
    answerRequired: "답을 고르거나 입력해 주세요",
    by: {
      allowed: "{who}님이 허용했어요",
      denied: "{who}님이 거부했어요",
      answered: "{who}님이 답했어요",
      approved: "{who}님이 push를 승인했어요",
      rejected: "{who}님이 push를 거절했어요",
    },
    already: {
      allowed: "이미 허용된 요청이에요",
      denied: "이미 거부된 요청이에요",
      answered: "이미 답한 요청이에요",
      approved: "이미 승인된 push 요청이에요",
      rejected: "이미 거절된 push 요청이에요",
      closed: "만료됐거나 더 이상 답할 수 없는 요청이에요",
    },
  },
  ja: {
    permissionTitle: "ツールの使用許可が必要です",
    questionTitle: "回答が必要な質問があります",
    pushTitle: "pushの承認が必要です",
    tool: "ツール",
    repository: "リポジトリ",
    branch: "ブランチ",
    commit: "コミット",
    allow: "許可",
    deny: "拒否",
    approve: "承認",
    reject: "却下",
    answer: "回答する",
    freeText: "直接入力",
    modalTitle: "質問に回答",
    submit: "送信",
    cancel: "キャンセル",
    freeTextLabel: "直接入力した回答",
    pushConfirm: "このコミットをブランチにpushします",
    expires: "回答がない場合、{time}に期限切れになります",
    link: "Webで開く",
    answerRequired: "回答を選ぶか入力してください",
    by: {
      allowed: "{who}さんが許可しました",
      denied: "{who}さんが拒否しました",
      answered: "{who}さんが回答しました",
      approved: "{who}さんがpushを承認しました",
      rejected: "{who}さんがpushを却下しました",
    },
    already: {
      allowed: "すでに許可されたリクエストです",
      denied: "すでに拒否されたリクエストです",
      answered: "すでに回答したリクエストです",
      approved: "すでに承認されたpushリクエストです",
      rejected: "すでに却下されたpushリクエストです",
      closed: "期限切れか、もう回答できないリクエストです",
    },
  },
  en: {
    permissionTitle: "A tool needs your permission",
    questionTitle: "A question needs your answer",
    pushTitle: "A push needs your approval",
    tool: "Tool",
    repository: "Repository",
    branch: "Branch",
    commit: "Commit",
    allow: "Allow",
    deny: "Deny",
    approve: "Approve",
    reject: "Reject",
    answer: "Answer",
    freeText: "Type an answer",
    modalTitle: "Answer the question",
    submit: "Send",
    cancel: "Cancel",
    freeTextLabel: "Your own answer",
    pushConfirm: "This pushes the commit to the branch",
    expires: "Expires at {time} if no one answers",
    link: "Open on the web",
    answerRequired: "Choose or type an answer",
    by: {
      allowed: "{who} allowed it",
      denied: "{who} denied it",
      answered: "{who} answered",
      approved: "{who} approved the push",
      rejected: "{who} rejected the push",
    },
    already: {
      allowed: "This request was already allowed",
      denied: "This request was already denied",
      answered: "This request was already answered",
      approved: "This push request was already approved",
      rejected: "This push request was already rejected",
      closed: "This request expired or can no longer be answered",
    },
  },
};

// Slack's limits on the fields used here.
const PLAIN_TEXT_MAX = 3000;
const BUTTON_TEXT_MAX = 75;
const OPTION_TEXT_MAX = 75;
const LABEL_MAX = 2000;
const MODAL_TITLE_MAX = 24;
const INPUT_PREVIEW_MAX = 2500;
const OPTIONS_MAX = 100;
const QUESTIONS_MAX = 10;
const OPTION_BUTTONS_MAX = 5;

const SLACK_ID = /^[A-Z0-9]{1,64}$/;

const clip = (value: string, max: number) => {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
};
const plain = (text: string, max = PLAIN_TEXT_MAX) => ({
  type: "plain_text",
  text: clip(text, max),
  emoji: false,
});
const mention = (slackUserId: string) =>
  SLACK_ID.test(slackUserId) ? `<@${slackUserId}>` : "";

function isSafeLink(url: string): boolean {
  if (/[<>|\s]/.test(url)) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function slackPromptValue(
  prompt: Pick<SlackPrompt, "sessionId" | "requestId">,
  option?: number,
): string {
  const value: SlackInteractionValue = {
    s: prompt.sessionId,
    r: prompt.requestId,
    ...(option === undefined ? {} : { o: String(option) }),
  };
  return JSON.stringify(value);
}

function button(
  text: string,
  actionId: string,
  value: string,
  style?: "primary" | "danger",
  confirm?: Record<string, unknown>,
) {
  return {
    type: "button",
    action_id: actionId,
    text: plain(text, BUTTON_TEXT_MAX),
    value,
    ...(style === undefined ? {} : { style }),
    ...(confirm === undefined ? {} : { confirm }),
  };
}

function answersByButton(questions: PendingQuestion[]): boolean {
  const [only] = questions;
  return (
    questions.length === 1 &&
    only !== undefined &&
    !only.multi_select &&
    only.options.length > 0 &&
    only.options.length <= OPTION_BUTTONS_MAX
  );
}

function slackDate(iso: string): string {
  const seconds = Math.floor(Date.parse(iso) / 1000);
  return Number.isFinite(seconds)
    ? `<!date^${seconds}^{date_short_pretty} {time}|${iso}>`
    : iso;
}

function inputPreview(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  let text: string;
  try {
    text =
      typeof input === "string"
        ? input
        : (JSON.stringify(input, null, 2) ?? "");
  } catch {
    return null;
  }
  return text === "" ? null : clip(text, INPUT_PREVIEW_MAX);
}

/**
 * The card for a request: what it asks in plain text, its buttons, and when
 * it expires. Model-written text never goes in a mrkdwn field, so it cannot
 * mention anyone or hide a link.
 */
export function slackPromptMessage(
  prompt: SlackPrompt,
  options: {
    locale: UserLocale;
    requesterSlackUserId: string | null;
    linkUrl?: string;
  },
): { text: string; blocks: unknown[] } {
  const copy = SLACK_PROMPT_MESSAGES[options.locale];
  const title =
    prompt.kind === "permission"
      ? copy.permissionTitle
      : prompt.kind === "question"
        ? copy.questionTitle
        : copy.pushTitle;
  const who =
    options.requesterSlackUserId === null
      ? ""
      : mention(options.requesterSlackUserId);
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${who ? `${who} ` : ""}*${title}*` },
    },
  ];
  const value = slackPromptValue(prompt);

  if (prompt.kind === "permission") {
    blocks.push({
      type: "section",
      text: plain(`${copy.tool}: ${prompt.tool}`),
    });
    const preview = inputPreview(prompt.input);
    if (preview !== null) {
      blocks.push({
        type: "rich_text",
        elements: [
          {
            type: "rich_text_preformatted",
            elements: [{ type: "text", text: preview }],
          },
        ],
      });
    }
    blocks.push({
      type: "actions",
      elements: [
        button(
          copy.allow,
          SLACK_INTERACTION_ACTIONS.permissionAllow,
          value,
          "primary",
        ),
        button(
          copy.deny,
          SLACK_INTERACTION_ACTIONS.permissionDeny,
          value,
          "danger",
        ),
      ],
    });
  } else if (prompt.kind === "question") {
    const questions = prompt.questions.slice(0, QUESTIONS_MAX);
    for (const question of questions) {
      const listed = answersByButton(prompt.questions)
        ? ""
        : question.options
            .slice(0, OPTIONS_MAX)
            .map((option) => `\n• ${option.label}`)
            .join("");
      blocks.push({
        type: "section",
        text: plain(`${question.prompt}${listed}`),
      });
    }
    const [only] = prompt.questions;
    if (answersByButton(prompt.questions) && only !== undefined) {
      blocks.push({
        type: "actions",
        elements: [
          ...only.options.map((option, index) =>
            button(
              option.label,
              `${SLACK_INTERACTION_ACTIONS.questionOption}:${index}`,
              slackPromptValue(prompt, index),
            ),
          ),
          ...(only.allow_free_text
            ? [
                button(
                  copy.freeText,
                  SLACK_INTERACTION_ACTIONS.questionOpen,
                  value,
                ),
              ]
            : []),
        ],
      });
    } else {
      blocks.push({
        type: "actions",
        elements: [
          button(
            copy.answer,
            SLACK_INTERACTION_ACTIONS.questionOpen,
            value,
            "primary",
          ),
        ],
      });
    }
  } else {
    blocks.push({
      type: "section",
      text: plain(
        `${copy.repository}: ${prompt.repositoryId}\n${copy.branch}: ${prompt.targetBranch}\n${copy.commit}: ${prompt.gitCommit.slice(0, 12)}`,
      ),
    });
    blocks.push({
      type: "actions",
      elements: [
        button(
          copy.approve,
          SLACK_INTERACTION_ACTIONS.pushApprove,
          value,
          "primary",
          {
            title: plain(copy.pushTitle, 100),
            text: plain(
              `${copy.pushConfirm}\n${prompt.targetBranch} ← ${prompt.gitCommit.slice(0, 12)}`,
              300,
            ),
            confirm: plain(copy.approve, 30),
            deny: plain(copy.cancel, 30),
          },
        ),
        button(
          copy.reject,
          SLACK_INTERACTION_ACTIONS.pushReject,
          value,
          "danger",
        ),
      ],
    });
  }

  const meta = [
    ...("expiresAt" in prompt
      ? [copy.expires.replace("{time}", slackDate(prompt.expiresAt))]
      : []),
    ...(options.linkUrl !== undefined && isSafeLink(options.linkUrl)
      ? [`<${options.linkUrl}|${copy.link}>`]
      : []),
  ];
  if (meta.length > 0) {
    blocks.push({
      type: "context",
      block_id: PROMPT_META_BLOCK,
      elements: [{ type: "mrkdwn", text: meta.join(" · ") }],
    });
  }
  return { text: `${who ? `${who} ` : ""}${title}`, blocks };
}

const PROMPT_META_BLOCK = "prompt.meta";

/**
 * The settled card: the request as it was asked, without its buttons or
 * expiry, and a line saying how it ended.
 */
export function slackSettledBlocks(
  asked: unknown[],
  result: SlackPromptResult,
  options: { locale: UserLocale; slackUserId: string | null },
): { text: string; blocks: unknown[] } {
  const copy = SLACK_PROMPT_MESSAGES[options.locale];
  const who = options.slackUserId === null ? "" : mention(options.slackUserId);
  const line =
    result === "closed" || who === ""
      ? copy.already[result]
      : copy.by[result].replace("{who}", who);
  const kept = asked.filter((block) => {
    if (typeof block !== "object" || block === null) return false;
    const { type, block_id } = block as { type?: unknown; block_id?: unknown };
    return type !== "actions" && block_id !== PROMPT_META_BLOCK;
  });
  return {
    text: line,
    blocks: [
      ...kept,
      { type: "context", elements: [{ type: "mrkdwn", text: line }] },
    ],
  };
}

const VALUE_ACTION = "v";
const choiceBlock = (index: number) => `q${index}`;
const textBlock = (index: number) => `q${index}.text`;

/** The modal for a question request; null when it has too many to show. */
export function slackQuestionView(
  questions: PendingQuestion[],
  metadata: SlackQuestionViewMetadata,
  locale: UserLocale,
): Record<string, unknown> | null {
  if (questions.length === 0 || questions.length > QUESTIONS_MAX) return null;
  const copy = SLACK_PROMPT_MESSAGES[locale];
  const blocks: unknown[] = [];
  for (const [index, question] of questions.entries()) {
    if (question.options.length > OPTIONS_MAX) return null;
    if (question.options.length > 0) {
      blocks.push({
        type: "input",
        block_id: choiceBlock(index),
        optional: question.allow_free_text,
        label: plain(question.prompt, LABEL_MAX),
        element: {
          type: question.multi_select ? "multi_static_select" : "static_select",
          action_id: VALUE_ACTION,
          options: question.options.map((option, optionIndex) => ({
            text: plain(option.label, OPTION_TEXT_MAX),
            value: String(optionIndex),
          })),
        },
      });
    }
    if (question.allow_free_text) {
      blocks.push({
        type: "input",
        block_id: textBlock(index),
        optional: question.options.length > 0,
        label: plain(
          question.options.length > 0 ? copy.freeTextLabel : question.prompt,
          LABEL_MAX,
        ),
        element: {
          type: "plain_text_input",
          action_id: VALUE_ACTION,
          multiline: true,
        },
      });
    }
  }
  return {
    type: "modal",
    callback_id: SLACK_QUESTION_VIEW_CALLBACK,
    private_metadata: JSON.stringify(metadata),
    title: plain(copy.modalTitle, MODAL_TITLE_MAX),
    submit: plain(copy.submit, MODAL_TITLE_MAX),
    close: plain(copy.cancel, MODAL_TITLE_MAX),
    blocks,
  };
}

type ViewValues = Record<string, Record<string, unknown>>;

function selectedIndexes(state: unknown): number[] {
  const element = state as {
    selected_option?: { value?: unknown } | null;
    selected_options?: { value?: unknown }[] | null;
  } | null;
  const picked = [
    ...(element?.selected_option ? [element.selected_option] : []),
    ...(element?.selected_options ?? []),
  ];
  return picked.map((option) =>
    typeof option.value === "string" && /^\d{1,3}$/.test(option.value)
      ? Number(option.value)
      : -1,
  );
}

/**
 * The answers a submitted modal gives, or the message to show under the
 * block that needs fixing. The options are those of the request as stored,
 * so a value the modal never offered cannot become an answer.
 */
export function slackQuestionAnswers(
  questions: PendingQuestion[],
  values: ViewValues,
  locale: UserLocale,
):
  | { ok: true; answers: QuestionAnswer[] }
  | { ok: false; errors: Record<string, string> } {
  const copy = SLACK_PROMPT_MESSAGES[locale];
  const answers: QuestionAnswer[] = [];
  const errors: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const picked = selectedIndexes(values[choiceBlock(index)]?.[VALUE_ACTION]);
    const selected = picked.map((at) => question.options[at]?.option_id);
    const typed = (
      values[textBlock(index)]?.[VALUE_ACTION] as
        | { value?: unknown }
        | undefined
    )?.value;
    const freeText =
      typeof typed === "string" && typed.trim() !== "" ? typed.trim() : null;
    const where =
      question.options.length > 0 ? choiceBlock(index) : textBlock(index);
    if (selected.some((id) => id === undefined)) {
      errors[where] = copy.answerRequired;
      continue;
    }
    if (selected.length === 0 && freeText === null) {
      errors[where] = copy.answerRequired;
      continue;
    }
    answers.push({
      question_id: question.question_id,
      selected_option_ids: selected as string[],
      ...(freeText === null ? {} : { free_text: freeText }),
    });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const mismatch = questionAnswerMismatch(questions, answers);
  if (mismatch !== null) {
    return {
      ok: false,
      errors: {
        [questions[0]?.options.length ? choiceBlock(0) : textBlock(0)]:
          copy.answerRequired,
      },
    };
  }
  return { ok: true, answers };
}

/** The answer one option button gives, or null for an index not offered. */
export function slackOptionAnswer(
  questions: PendingQuestion[],
  option: string | undefined,
): QuestionAnswer[] | null {
  const [only] = questions;
  if (
    !answersByButton(questions) ||
    only === undefined ||
    option === undefined ||
    !/^\d{1,3}$/.test(option)
  ) {
    return null;
  }
  const picked = only.options[Number(option)];
  return picked === undefined
    ? null
    : [
        {
          question_id: only.question_id,
          selected_option_ids: [picked.option_id],
        },
      ];
}
