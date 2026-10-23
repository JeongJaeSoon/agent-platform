import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  RelativeTime,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type TimestampLocale,
} from "@werft-ai/ui";

// A fixed "now" keeps every boundary's text the same in each run.
const NOW = Date.parse("2026-10-24T15:14:02+09:00");

const BOUNDARIES: [label: string, at: string][] = [
  ["1분 미만", "2026-10-24T15:13:30+09:00"],
  ["60분 미만", "2026-10-24T14:59:00+09:00"],
  ["오늘", "2026-10-24T09:05:00+09:00"],
  ["어제", "2026-10-23T23:59:00+09:00"],
  ["같은 해", "2026-10-02T11:00:00+09:00"],
  ["다른 해", "2025-12-31T11:00:00+09:00"],
];

const LOCALES: readonly TimestampLocale[] = ["ko", "ja", "en"];

function locale(value: unknown): TimestampLocale {
  return LOCALES.includes(value as TimestampLocale)
    ? (value as TimestampLocale)
    : "ko";
}

const meta = {
  title: "Primitives/RelativeTime",
  component: RelativeTime,
  args: { value: "2026-10-24T14:59:00+09:00", now: NOW },
  render: (args, { globals }) => (
    <RelativeTime
      {...args}
      locale={locale(globals.locale)}
      className="text-caption text-subtle-foreground"
    />
  ),
} satisfies Meta<typeof RelativeTime>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Japanese: Story = { globals: { locale: "ja" } };

export const English: Story = { globals: { locale: "en" } };

// Each boundary in all three languages; the cells sit right like a list's.
export const Boundaries: Story = {
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>경계</TableHead>
          {LOCALES.map((code) => (
            <TableHead key={code} className="text-right">
              {code}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {BOUNDARIES.map(([label, at]) => (
          <TableRow key={label}>
            <TableCell>{label}</TableCell>
            {LOCALES.map((code) => (
              <TableCell key={code} className="text-right">
                <RelativeTime
                  value={at}
                  now={NOW}
                  locale={code}
                  className="text-caption text-subtle-foreground"
                />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

export const Open: Story = {
  render: (args, { globals }) => (
    <div className="story-row">
      <RelativeTime
        {...args}
        locale={locale(globals.locale)}
        className="text-caption text-subtle-foreground"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    canvasElement.querySelector("time")?.focus();
  },
};

export const Dark: Story = {
  ...Boundaries,
  globals: { theme: "dark" },
};

export const Mobile390: Story = {
  ...Boundaries,
  name: "Boundaries (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
