import type { Meta, StoryObj } from "@storybook/react-vite";
import { SkipLink } from "@werft-ai/ui";
import { type JSX, useId } from "react";
import { expect, userEvent, within } from "storybook/test";

const COPY = {
  ko: { skip: "본문으로 건너뛰기", nav: "에이전트", main: "본문" },
  ja: { skip: "本文へスキップ", nav: "エージェント", main: "本文" },
  en: { skip: "Skip to content", nav: "Agents", main: "Main content" },
};

function Page({ locale }: { readonly locale: string }): JSX.Element {
  const copy = COPY[locale as keyof typeof COPY] ?? COPY.ko;
  const mainId = useId();
  return (
    <div className="relative min-h-40 pt-12">
      <SkipLink href={`#${mainId}`}>{copy.skip}</SkipLink>
      <nav aria-label={copy.nav}>
        <a href="#agents">{copy.nav}</a>
      </nav>
      <main id={mainId} tabIndex={-1} className="mt-4">
        {copy.main}
      </main>
    </div>
  );
}

const meta = {
  title: "Primitives/SkipLink",
  component: SkipLink,
  args: { href: "#main" },
  render: (_args, { globals }) => <Page locale={globals.locale} />,
} satisfies Meta<typeof SkipLink>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Off screen until the first Tab, then drawn where layout.tsx draws it. */
export const Focused: Story = {
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole("link", {
      name: /본문|本文|content/,
    });
    const hidden = link.getBoundingClientRect();
    await userEvent.tab();
    await expect(link).toHaveFocus();
    const shown = link.getBoundingClientRect();
    // Unfocused it sits -200% of its own height up.
    await expect(shown.top - hidden.top).toBeCloseTo(2 * shown.height, 0);
    await expect(shown.top).toBeGreaterThanOrEqual(0);
  },
};

export const Japanese: Story = { ...Focused, globals: { locale: "ja" } };

export const English: Story = { ...Focused, globals: { locale: "en" } };

/** Following the link moves focus to the main content. */
export const SkipsToMain: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await expect(within(canvasElement).getByRole("main")).toHaveFocus();
  },
};

export const Dark: Story = { ...Focused, globals: { theme: "dark" } };

export const Mobile390: Story = {
  ...Focused,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
