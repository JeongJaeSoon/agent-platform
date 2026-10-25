import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Link,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import type { ComponentProps, JSX } from "react";
import { expect, userEvent, within } from "storybook/test";

const meta = {
  title: "Primitives/Link",
  component: Link,
  args: { href: "#teams" },
  argTypes: {
    underline: { control: "select", options: ["hover", "always"] },
    variant: { control: "select", options: ["default", "table", "more"] },
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
    teams: "팀",
    name: "이름",
    members: "구성원",
    rows: ["운영팀", "결제 플랫폼팀"],
  },
  ja: {
    team: "運用チーム",
    question: "アカウントをお持ちでないですか？",
    signUp: "登録する",
    docs: "APIドキュメント",
    newTab: "(新しいタブで開きます)",
    teams: "チーム",
    name: "名前",
    members: "メンバー",
    rows: ["運用チーム", "決済プラットフォームチーム"],
  },
  en: {
    team: "Operations team",
    question: "No account?",
    signUp: "Sign up",
    docs: "API docs",
    newTab: "(opens in a new tab)",
    teams: "Teams",
    name: "Name",
    members: "Members",
    rows: ["Operations team", "Payments platform team"],
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
        <p>
          <Link href="#teams">{copy.team}</Link>
        </p>
        <p className="text-body">
          {copy.question}{" "}
          <Link href="#signup" underline="always">
            {copy.signUp}
          </Link>
        </p>
        <p>
          <Link
            href="https://example.com/docs"
            target="_blank"
            newTabLabel={copy.newTab}
          >
            {copy.docs}
          </Link>
        </p>
      </div>
    );
  },
};

export const Dark: Story = { ...All, globals: { theme: "dark" } };

export const Mobile390: Story = {
  ...All,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

/**
 * `variant="table"`: a row's name link, no underline until hover or keyboard
 * focus, and no chevron beside the name.
 */
export const InTable: Story = {
  render: (_args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <TableContainer label={copy.teams}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{copy.name}</TableHead>
              <TableHead>{copy.members}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {copy.rows.map((name, index) => (
              <TableRow key={name}>
                <TableCell>
                  <Link asChild={true} variant="table">
                    <RouterLink to={`#teams/${index + 1}`}>{name}</RouterLink>
                  </Link>
                </TableCell>
                <TableCell>{(index + 1) * 4}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    );
  },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getAllByRole("link")[0] as HTMLElement;
    await expect(getComputedStyle(link).textDecorationLine).toBe("none");
    await expect(link.querySelector("svg")).toBeNull();
    // The first Tab stops on the scrollable table container.
    await userEvent.tab();
    await userEvent.tab();
    await expect(link).toHaveFocus();
    await expect(getComputedStyle(link).textDecorationLine).toBe("underline");
    await expect(getComputedStyle(link).outlineStyle).toBe("solid");
  },
};

export const InTableJapanese: Story = {
  ...InTable,
  globals: { locale: "ja" },
};

export const InTableEnglish: Story = { ...InTable, globals: { locale: "en" } };

export const InTableDark: Story = { ...InTable, globals: { theme: "dark" } };

export const InTableMobile390: Story = {
  ...InTable,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

const MORE = { ko: "전체 보기", ja: "すべて表示", en: "View all" };

/**
 * `variant="more"`: a section's "view all", 13px with a trailing 14px arrow
 * (console v4 L534).
 */
export const More: Story = {
  render: (_args, { globals }) => (
    <div className="flex items-center justify-between gap-4">
      <h2 className="m-0 text-body font-semibold">
        {copyFor(globals.locale).teams}
      </h2>
      <Link asChild={true} variant="more">
        <RouterLink to="#teams">
          {MORE[globals.locale as Locale] ?? MORE.ko}
        </RouterLink>
      </Link>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole("link");
    const icon = link.querySelector("svg") as SVGElement;
    await expect(icon.getAttribute("aria-hidden")).toBe("true");
    await expect(icon.getBoundingClientRect().width).toBe(14);
    await expect(getComputedStyle(link).columnGap).toBe("4px");
    await expect(getComputedStyle(link).fontSize).toBe("13px");
  },
};

export const MoreJapanese: Story = { ...More, globals: { locale: "ja" } };

export const MoreEnglish: Story = { ...More, globals: { locale: "en" } };

export const MoreDark: Story = { ...More, globals: { theme: "dark" } };

export const MoreMobile390: Story = {
  ...More,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
