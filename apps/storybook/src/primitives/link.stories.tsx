import type { Meta, StoryObj } from "@storybook/react-vite";
import { Link } from "@werft-ai/ui";
import type { ComponentProps, JSX } from "react";
import { expect, userEvent, within } from "storybook/test";

const meta = {
  title: "Primitives/Link",
  component: Link,
  args: { href: "#teams" },
  argTypes: {
    underline: { control: "select", options: ["hover", "always"] },
  },
} satisfies Meta<typeof Link>;

export default meta;
type Story = StoryObj<typeof meta>;

const COPY = {
  ko: {
    team: "운영팀",
    question: "계정이 없나요?",
    signUp: "가입하기",
    docs: "API 문서",
    newTab: "(새 탭에서 열림)",
  },
  ja: {
    team: "運用チーム",
    question: "アカウントをお持ちでないですか？",
    signUp: "登録する",
    docs: "APIドキュメント",
    newTab: "(新しいタブで開きます)",
  },
  en: {
    team: "Operations team",
    question: "No account?",
    signUp: "Sign up",
    docs: "API docs",
    newTab: "(opens in a new tab)",
  },
};
type Locale = keyof typeof COPY;

function copyFor(locale: string) {
  return COPY[locale as Locale] ?? COPY.ko;
}

// Stands in for TanStack Router's <Link>: `to` becomes href and the ref
// reaches its <a>, which is all asChild relies on.
function RouterLink({
  to,
  ...props
}: Omit<ComponentProps<"a">, "href"> & { readonly to: string }): JSX.Element {
  return <a href={to} {...props} />;
}

/** A standalone link (a name in a list): underlined on hover. */
export const Default: Story = {
  render: (args, { globals }) => (
    <Link {...args}>{copyFor(globals.locale).team}</Link>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.tab();
    const link = within(canvasElement).getByRole("link");
    await expect(link).toHaveFocus();
    const style = getComputedStyle(link);
    await expect(style.outlineStyle).toBe("solid");
    await expect(style.outlineWidth).toBe("2px");
    await expect(style.outlineOffset).toBe("2px");
  },
};

export const Japanese: Story = { ...Default, globals: { locale: "ja" } };

export const English: Story = { ...Default, globals: { locale: "en" } };

/** A link inside a sentence: always underlined, at the sentence's weight. */
export const Always: Story = {
  render: (_args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <p className="text-body">
        {copy.question}{" "}
        <Link href="#signup" underline="always">
          {copy.signUp}
        </Link>
      </p>
    );
  },
};

/** The router's own link keeps its href and ref and takes the look. */
export const AsChild: Story = {
  render: (_args, { globals }) => (
    <Link asChild={true}>
      <RouterLink to="#teams/1">{copyFor(globals.locale).team}</RouterLink>
    </Link>
  ),
};

/** A new tab gets rel="noopener noreferrer" and says so to screen readers. */
export const External: Story = {
  render: (_args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <Link
        href="https://example.com/docs"
        target="_blank"
        newTabLabel={copy.newTab}
      >
        {copy.docs}
      </Link>
    );
  },
};

const All: Story = {
  render: (_args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <div className="story-stack">
        <Link href="#teams">{copy.team}</Link>
        <p className="text-body">
          {copy.question}{" "}
          <Link href="#signup" underline="always">
            {copy.signUp}
          </Link>
        </p>
        <Link
          href="https://example.com/docs"
          target="_blank"
          newTabLabel={copy.newTab}
        >
          {copy.docs}
        </Link>
      </div>
    );
  },
};

export const Dark: Story = { ...All, globals: { theme: "dark" } };

export const Mobile390: Story = {
  ...All,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
