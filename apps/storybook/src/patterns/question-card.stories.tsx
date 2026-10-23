import type { Meta, StoryObj } from "@storybook/react-vite";
import { QuestionCard, type QuestionRequest } from "@werft-ai/react/components";

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
  title: "Patterns/Session/QuestionCard",
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

/** Nothing to answer once it expired. */
export const Empty: Story = {
  args: { now: Date.parse(REQUEST.expires_at) },
};

/** The answer is on its way. */
export const Loading: Story = { args: { pending: true } };

export const Failed: Story = {
  args: { error: "This request was already answered, expired or closed." },
};

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      {Object.entries({ Default, Empty, Loading, Failed }).map(
        ([name, story]) => (
          <QuestionCard key={name} {...args} {...story.args} />
        ),
      )}
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
