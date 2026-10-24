import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar } from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const PEOPLE = {
  ko: ["김민지", "이서준", "박하은", "최도윤"],
  ja: ["佐藤 花子", "鈴木 一郎", "高橋 美咲", "田中 健"],
  en: ["Mina Kim", "Seojun Lee", "Haeun Park", "Doyun Choi"],
} as const;

const INITIALS = {
  ko: ["민지", "서준", "하은", "도윤"],
  ja: ["花", "一", "美", "健"],
  en: ["MK", "SL", "HP", "DC"],
} as const;

type Locale = keyof typeof PEOPLE;
const localeOf = (locale: unknown): Locale =>
  locale === "ja" || locale === "en" ? locale : "ko";

const TONES = [1, 2, 3, 4] as const;

const meta = {
  title: "Primitives/Avatar",
  component: Avatar,
  args: { initials: "JS" },
  argTypes: {
    size: { control: "select", options: ["default", "lg"] },
    shape: { control: "select", options: ["circle", "square"] },
    tone: { control: "select", options: ["default", 1, 2, 3, 4] },
  },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/**
 * Every size, shape and tone. With its name beside it the avatar is
 * decoration; alone, `label` gives it the name.
 */
export const Matrix: Story = {
  render: (_args, { globals }) => {
    const locale = localeOf(globals.locale);
    return (
      <div className="flex flex-col gap-4">
        {(["default", "lg"] as const).map((size) =>
          (["circle", "square"] as const).map((shape) => (
            <div key={`${size}-${shape}`} className="story-row">
              <Avatar size={size} shape={shape} initials="AP" />
              {TONES.map((tone, index) => (
                <Avatar
                  key={tone}
                  size={size}
                  shape={shape}
                  tone={tone}
                  initials={INITIALS[locale][index] ?? "AP"}
                  label={PEOPLE[locale][index]}
                />
              ))}
            </div>
          )),
        )}
      </div>
    );
  },
};

export const MatrixDark: Story = {
  ...Matrix,
  name: "Matrix (dark)",
  globals: { theme: "dark" },
};

/** The home request row: a square avatar beside the name it stands for. */
export const WithName: Story = {
  render: (_args, { globals }) => {
    const locale = localeOf(globals.locale);
    return (
      <div className="flex flex-col gap-2">
        {TONES.map((tone, index) => (
          <div key={tone} className="flex items-center gap-2 text-control">
            <Avatar
              shape="square"
              tone={tone}
              initials={INITIALS[locale][index] ?? "AP"}
            />
            {PEOPLE[locale][index]}
          </div>
        ))}
      </div>
    );
  },
};

export const WithNameDark: Story = {
  ...WithName,
  name: "With name (dark)",
  globals: { theme: "dark" },
};

export const Mobile: Story = {
  ...Matrix,
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};
