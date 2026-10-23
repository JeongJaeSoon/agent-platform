import type { Meta, StoryObj } from "@storybook/react-vite";
import { sessionsJa, sessionsKo } from "@werft-ai/react";
import {
  QuestionCard,
  type QuestionCardMessages,
  type QuestionRequest,
} from "@werft-ai/react/components";

// A fixed clock, as in the other stories.
const NOW = Date.parse("2026-10-21T01:00:00.000Z");

const REQUEST: QuestionRequest = {
  request_id: "req_02",
  turn_id: "1",
  attempt_id: "att_01",
  kind: "question",
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: "2026-10-21T01:10:00.000Z",
  questions: [
    {
      question_id: "q_branch",
      prompt: "Which branch should the fix go on?",
      options: [
        { option_id: "main", label: "main" },
        { option_id: "release", label: "release/1.4" },
      ],
      multi_select: false,
      allow_free_text: false,
    },
    {
      question_id: "q_checks",
      prompt: "Which checks should run first?",
      options: [
        { option_id: "unit", label: "Unit tests" },
        { option_id: "lint", label: "Lint" },
      ],
      multi_select: true,
      allow_free_text: true,
    },
  ],
};

const meta = {
  title: "Domain/Session/QuestionCard",
  // The example copy is English; the page language should say so.
  globals: { locale: "en" },
  component: QuestionCard,
  args: {
    request: REQUEST,
    messages: {
      title: "Question",
      expires: (at: string) => `Answer by ${at}`,
      expired: "This request expired.",
      freeText: "Write your own",
      unanswered: "Pick an option or write an answer.",
      submit: "Send answer",
    },
    onSubmit: () => {},
    now: NOW,
    locale: "en",
  },
} satisfies Meta<typeof QuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Options wrap onto more lines; a long label wraps inside its chip. */
export const ManyOptions: Story = {
  args: {
    request: {
      ...REQUEST,
      questions: [
        {
          question_id: "q_runtime",
          prompt: "Which runtime should the worker image pin?",
          options: [
            "bun 1.3.14",
            "bun 1.4.2",
            "node 22",
            "node 24",
            "deno 2",
            "Keep whatever the base image ships with today and pin it in a follow-up change once the CI cache is warm again",
          ].map((label, index) => ({ option_id: `rt_${index}`, label })),
          multi_select: false,
          allow_free_text: true,
        },
        {
          question_id: "q_targets",
          prompt: "Which targets should the build produce?",
          options: [
            "linux/amd64",
            "linux/arm64",
            "darwin/arm64",
            "windows/amd64",
            "a static musl build for the scratch image",
          ].map((label, index) => ({ option_id: `tg_${index}`, label })),
          multi_select: true,
          allow_free_text: false,
        },
      ],
    },
  },
};

/** No options: the answer is free text, so the field starts open. */
export const FreeTextOnly: Story = {
  args: {
    request: {
      ...REQUEST,
      questions: [
        {
          question_id: "q_reason",
          prompt: "What should the commit message say?",
          options: [],
          multi_select: false,
          allow_free_text: true,
        },
      ],
    },
  },
};

/** The folded free-text field, opened. */
export const WritingOwn: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Write your own" }),
    );
  },
};

/** Sent with a question left open: its free-text field unfolds. */
export const Unanswered: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("radio", { name: "main" }));
    await userEvent.click(canvas.getByRole("button", { name: "Send answer" }));
  },
};

/** Nothing to answer once it expired. */
export const Empty: Story = {
  args: { now: Date.parse(REQUEST.expires_at) },
};

/** The answer is on its way. */
export const Loading: Story = { args: { pending: true } };

export const Failed: Story = {
  name: "Error",
  args: { error: "This request was already answered, expired or closed." },
};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const DefaultMobile: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

// The blocks' own wording, so each language story reads as the console does.
function messagesFrom(
  catalog: Record<keyof typeof sessionsKo, string>,
): QuestionCardMessages {
  return {
    title: catalog["session.pending.question"],
    expires: (at) => catalog["session.pending.expires"].replace("{at}", at),
    expired: catalog["session.pending.expired"],
    freeText: catalog["session.answer.freeText"],
    unanswered: catalog["session.answer.unanswered"],
    submit: catalog["session.answer.submit"],
  };
}

type Question = QuestionRequest["questions"][number];

function requestIn(prompts: [string, string], labels: string[]) {
  const [branch, checks] = REQUEST.questions as [Question, Question];
  return {
    ...REQUEST,
    questions: [
      { ...branch, prompt: prompts[0] },
      {
        ...checks,
        prompt: prompts[1],
        options: checks.options.map((option, index) => ({
          ...option,
          label: labels[index] ?? option.label,
        })),
      },
    ],
  } as QuestionRequest;
}

export const Korean: Story = {
  name: "Default (한국어)",
  globals: { locale: "ko" },
  args: {
    messages: messagesFrom(sessionsKo),
    locale: "ko",
    request: requestIn(
      ["수정을 어느 브랜치에 올릴까요?", "어떤 검사를 먼저 돌릴까요?"],
      ["단위 테스트", "린트"],
    ),
  },
};

export const Japanese: Story = {
  name: "Default (日本語)",
  globals: { locale: "ja" },
  args: {
    messages: messagesFrom(sessionsJa),
    locale: "ja",
    request: requestIn(
      ["修正はどのブランチに入れますか？", "どのチェックを先に実行しますか？"],
      ["単体テスト", "Lint"],
    ),
  },
};

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      {Object.entries({
        Default,
        ManyOptions,
        FreeTextOnly,
        Empty,
        Loading,
        Failed,
      }).map(([name, story]) => (
        <QuestionCard key={name} {...args} {...story.args} />
      ))}
    </div>
  ),
};

export const StatesDark: Story = {
  ...States,
  name: "States (dark)",
  globals: { theme: "dark" },
};

export const StatesMobile: Story = {
  ...States,
  name: "States (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
