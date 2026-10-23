import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  RowLines,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import { Info } from "lucide-react";
import type { CSSProperties } from "react";
import { expect, within } from "storybook/test";

type Locale = "ko" | "ja" | "en";

const COPY = {
  ko: {
    label: "구성원",
    name: "이름",
    role: "역할",
    joined: "가입일",
    manage: "관리",
    admin: "관리자",
    member: "구성원",
    disable: "비활성화",
    enable: "다시 사용",
    disableFor: (name: string) => `${name} 비활성화`,
    enableFor: (name: string) => `${name} 다시 사용`,
    whyFor: (name: string) => `${name}: 바꿀 수 없는 이유`,
  },
  ja: {
    label: "メンバー",
    name: "名前",
    role: "役割",
    joined: "参加日",
    manage: "管理",
    admin: "管理者",
    member: "メンバー",
    disable: "無効化",
    enable: "再び有効化",
    disableFor: (name: string) => `${name}を無効化`,
    enableFor: (name: string) => `${name}を再び有効化`,
    whyFor: (name: string) => `${name}: 変更できない理由`,
  },
  en: {
    label: "Members",
    name: "Name",
    role: "Role",
    joined: "Joined",
    manage: "Manage",
    admin: "Admin",
    member: "Member",
    disable: "Disable",
    enable: "Enable again",
    disableFor: (name: string) => `Disable ${name}`,
    enableFor: (name: string) => `Enable again: ${name}`,
    whyFor: (name: string) => `Why ${name} can't be changed`,
  },
} satisfies Record<Locale, unknown>;

const PEOPLE = [
  {
    name: "김하나",
    email: "hana.kim@example.com",
    admin: true,
    joined: "2026-03-02",
    disabled: false,
  },
  {
    name: "Taro Yamada",
    email: "taro.yamada@example.com",
    admin: false,
    joined: "2026-05-18",
    disabled: true,
  },
  {
    name: "Alex Rivera",
    email: "alex.rivera.long-address@example.com",
    admin: false,
    joined: "2026-09-30",
    disabled: false,
  },
];

function copyOf(locale: unknown) {
  return COPY[(locale as Locale) in COPY ? (locale as Locale) : "ko"];
}

interface MembersProps {
  readonly locale: unknown;
  readonly twoLine?: boolean;
  readonly actions?: boolean;
  /** An icon button beside the admin's row button, as ReasonHint draws it. */
  readonly hint?: boolean;
  readonly style?: CSSProperties;
}

/*
 * The members screen's shape: column heads with scope="col", and a row
 * button whose accessible name carries the row — the caller's job, since the
 * table cannot know what a button does.
 */
function Members({ locale, twoLine, actions, hint, style }: MembersProps) {
  const t = copyOf(locale);
  return (
    <TableContainer label={t.label} style={style}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t.name}</TableHead>
            <TableHead scope="col">{t.role}</TableHead>
            <TableHead scope="col">{t.joined}</TableHead>
            {actions ? (
              <TableHead scope="col" variant="actions">
                {t.manage}
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {PEOPLE.map((person) => (
            <TableRow key={person.email}>
              <TableCell>
                {twoLine ? (
                  <RowLines>
                    <span className="font-semibold">{person.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {person.email}
                    </span>
                  </RowLines>
                ) : (
                  person.name
                )}
              </TableCell>
              <TableCell>
                <Badge variant={person.admin ? "blue" : "gray"}>
                  {person.admin ? t.admin : t.member}
                </Badge>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {person.joined}
              </TableCell>
              {actions ? (
                <TableCell variant="actions">
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={
                        person.disabled
                          ? t.enableFor(person.name)
                          : t.disableFor(person.name)
                      }
                    >
                      {person.disabled ? t.enable : t.disable}
                    </Button>
                    {hint && person.admin ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-[var(--ap-control-height-sm)]"
                        aria-label={t.whyFor(person.name)}
                      >
                        <Info aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

const meta = {
  title: "Primitives/Table",
  component: Table,
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (_, { globals }) => <Members locale={globals.locale} />,
};

/**
 * `variant="actions"` on the head and cells: the column fits its buttons and
 * each button is at least --ap-row-action-min-width (96px) wide, so "disable"
 * and "enable again" keep one width.
 */
export const Actions: Story = {
  render: (_, { globals }) => (
    <Members locale={globals.locale} twoLine={true} actions={true} />
  ),
};

/** RowLines in a cell: a 20px first line, then 16px lines 2px apart. */
export const TwoLineCells: Story = {
  name: "Two-line cells",
  render: (_, { globals }) => (
    <Members locale={globals.locale} twoLine={true} />
  ),
};

/**
 * A table wider than its frame scrolls sideways inside it. The frame is a tab
 * stop with a name, so a keyboard reaches it and scrolls with the arrow keys.
 */
export const HorizontalScroll: Story = {
  name: "Horizontal scroll",
  render: (_, { globals }) => (
    <div className="max-w-xs">
      <Members locale={globals.locale} twoLine={true} actions={true} />
    </div>
  ),
};

/** The actions column follows the token: here it is set to 8rem. */
export const ActionWidthToken: Story = {
  name: "Action width from token",
  render: (_, { globals }) => (
    <Members
      locale={globals.locale}
      actions={true}
      style={{ "--ap-row-action-min-width": "8rem" } as CSSProperties}
    />
  ),
};

export const Dark: Story = {
  ...Actions,
  name: "Actions (dark)",
  globals: { theme: "dark" },
};

export const Mobile390: Story = {
  ...Actions,
  name: "Actions (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const Korean: Story = {
  ...Actions,
  name: "Actions (ko)",
  globals: { locale: "ko" },
};

export const Japanese: Story = {
  ...Actions,
  name: "Actions (ja)",
  globals: { locale: "ja" },
};

export const English: Story = {
  ...Actions,
  name: "Actions (en)",
  globals: { locale: "en" },
};

/**
 * An icon button in the actions column keeps its square size; only labelled
 * buttons take the --ap-row-action-min-width floor.
 */
export const ActionsWithIconButton: Story = {
  name: "Actions with an icon button",
  render: (_, { globals }) => (
    <Members
      locale={globals.locale}
      twoLine={true}
      actions={true}
      hint={true}
    />
  ),
  play: async ({ canvasElement }) => {
    const icon = canvasElement.querySelector("[data-size=icon]");
    const labelled = canvasElement.querySelector("[data-size=sm]");
    if (icon === null || labelled === null) throw new Error("no buttons");
    await expect(within(canvasElement).getAllByRole("button").length).toBe(4);
    await expect(icon.getBoundingClientRect().width).toBe(28);
    await expect(labelled.getBoundingClientRect().width).toBeGreaterThanOrEqual(
      96,
    );
  },
};

export const ActionsWithIconButtonDark: Story = {
  ...ActionsWithIconButton,
  name: "Actions with an icon button (dark)",
  globals: { theme: "dark" },
};

export const ActionsWithIconButton390: Story = {
  ...ActionsWithIconButton,
  name: "Actions with an icon button (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
