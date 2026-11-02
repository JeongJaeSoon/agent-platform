import type { Meta, StoryObj } from "@storybook/react-vite";
import { SessionRowOpener } from "@werft-ai/react/components";
import {
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Text,
} from "@werft-ai/ui";
import { expect } from "storybook/test";

import { MOBILE } from "../../screens/screen-kit.tsx";
import { SESSION } from "./session-fixtures.ts";

/**
 * A session row's one link, laid over the whole row: the screen draws it
 * with its router through `renderLink`, the opener gives it the row's
 * hover, focus ring and name. The row's text stays plain text beside it.
 */
const meta = {
  title: "Domain/Session/SessionRowOpener",
  component: SessionRowOpener,
  render: (args) => (
    <GridTable aria-label="세션" columns="minmax(0,1fr) 120px">
      <GridTableHeader>
        <GridTableColumnHeader>제목</GridTableColumnHeader>
        <GridTableColumnHeader>상태</GridTableColumnHeader>
      </GridTableHeader>
      <GridTableRow>
        <GridTableCell>
          <SessionRowOpener {...args} />
          <Text as="span" className="truncate font-medium text-link">
            배포 점검
          </Text>
        </GridTableCell>
        <GridTableCell>실행 중</GridTableCell>
      </GridTableRow>
    </GridTable>
  ),
  args: {
    name: "세션 열기: 배포 점검",
    title: SESSION.id,
    renderLink: (link) => <a href={`#sessions/${SESSION.id}`} {...link} />,
  },
} satisfies Meta<typeof SessionRowOpener>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    const link = canvas.getByRole("link", { name: "세션 열기: 배포 점검" });
    await expect(link).toHaveAttribute("title", SESSION.id);
  },
};

/**
 * A renderLink that returns a fragment cannot be the opener's child, so the
 * link carries the opener's look itself and still covers the row.
 */
export const FragmentLink: Story = {
  args: {
    renderLink: (link) => (
      <>
        <a href={`#sessions/${SESSION.id}`} {...link} />
      </>
    ),
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = { name: "Default (390px)", globals: MOBILE };
