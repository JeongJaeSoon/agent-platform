import type { Meta, StoryObj } from "@storybook/react-vite";
import tokensCss from "@werft-ai/ui/tokens.css?raw";
import { useId } from "react";
import { KitSample } from "./kit-sample.tsx";
import { parseTokens, type Tokens, themeStyle } from "./tokens.ts";

const { light, dark } = parseTokens(tokensCss);

// Every utility reads `--ap-*` at runtime (theme.css `@theme inline`), so a
// subtree that redefines the tokens draws in that theme.
function Themed({
  title,
  tokens,
  scheme,
}: {
  readonly title: string;
  readonly tokens: Tokens;
  readonly scheme: "light" | "dark";
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      style={{ ...themeStyle(tokens), colorScheme: scheme }}
      className="min-w-0 rounded-card border bg-background p-6 text-foreground"
    >
      <h2 id={headingId} className="mb-4 font-medium text-body">
        {title}
      </h2>
      <KitSample scope={title} />
    </section>
  );
}

const meta = {
  title: "Foundations/Light and dark",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The toolbar's Theme does not change this view: both are always drawn. */
export const SideBySide: Story = {
  name: "Side by side",
  render: () => (
    <div className="grid gap-4 p-4 lg:grid-cols-2">
      <Themed title="Light" tokens={light} scheme="light" />
      <Themed title="Dark" tokens={dark} scheme="dark" />
    </div>
  ),
};
