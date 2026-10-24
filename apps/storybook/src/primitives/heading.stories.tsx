import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, Heading } from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: { title: "워크스페이스 설정", section: "구성원", card: "API 키" },
  ja: { title: "ワークスペース設定", section: "メンバー", card: "API キー" },
  en: { title: "Workspace settings", section: "Members", card: "API keys" },
} as const;

type Locale = keyof typeof COPY;
const localeOf = (locale: unknown): Locale =>
  locale === "ja" || locale === "en" ? locale : "ko";

const meta = {
  title: "Primitives/Heading",
  component: Heading,
  args: { children: "구성원" },
  argTypes: {
    level: { control: "select", options: [1, 2, 3, 4, 5, 6] },
    size: { control: "inline-radio", options: ["title", "section"] },
  },
} satisfies Meta<typeof Heading>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/**
 * `size` against `level`: the element follows the outline, the look does not.
 * v4 `.page-title` is 20/28/600; `.section-title` and `.card-title` 14/20/600.
 */
export const Matrix: Story = {
  render: (_args, { globals }) => {
    const copy = COPY[localeOf(globals.locale)];
    return (
      <div className="story-stack">
        {(["title", "section"] as const).map((size) =>
          ([1, 2, 3] as const).map((level) => (
            <Heading key={`${size}-${level}`} level={level} size={size}>
              {size === "title" ? copy.title : copy.section} — h{level} · {size}
            </Heading>
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

/** A page title over a section title with its count (v4 `.section-title`). */
export const WithBadge: Story = {
  render: (_args, { globals }) => {
    const copy = COPY[localeOf(globals.locale)];
    return (
      <div className="story-stack">
        <Heading level={1} size="title">
          {copy.title}
        </Heading>
        <div className="flex items-center gap-2">
          <Heading>{copy.section}</Heading>
          <Badge>12</Badge>
        </div>
        <Heading level={3}>{copy.card}</Heading>
      </div>
    );
  },
};

export const WithBadgeDark: Story = {
  ...WithBadge,
  name: "With badge (dark)",
  globals: { theme: "dark" },
};

export const Mobile390: Story = {
  ...WithBadge,
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};
