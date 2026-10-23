import type { Meta, StoryObj } from "@storybook/react-vite";
import tokensCss from "@werft-ai/ui/tokens.css?raw";
import type { ReactNode } from "react";
import { parseTokens, themeStyle, withPrefix } from "./tokens.ts";

const { light, dark } = parseTokens(tokensCss);

/*
 * One row per token, its light and dark value side by side whatever the
 * toolbar's Theme says: each cell carries its theme's tokens inline.
 */
function TokenTable({
  prefixes,
  preview,
}: {
  readonly prefixes: string[];
  readonly preview?: (name: string) => ReactNode;
}) {
  return (
    <table className="w-full border-collapse text-control">
      <thead>
        <tr className="text-left">
          <th scope="col" className="py-2 pr-4 font-medium">
            Token
          </th>
          <th scope="col" className="p-2 font-medium">
            Light
          </th>
          <th scope="col" className="p-2 font-medium">
            Dark
          </th>
        </tr>
      </thead>
      <tbody>
        {withPrefix(light, ...prefixes).map((name) => (
          <tr key={name} className="border-t">
            <th
              scope="row"
              className="py-2 pr-4 text-left font-mono font-normal"
            >
              {name}
            </th>
            {[light, dark].map((tokens, index) => (
              <td
                key={index === 0 ? "light" : "dark"}
                style={themeStyle(tokens)}
                className="bg-background p-2 text-foreground"
              >
                <div className="flex flex-wrap items-center gap-3">
                  {preview?.(name)}
                  <code className="font-mono text-caption">
                    {tokens.get(name)}
                  </code>
                </div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const meta = {
  title: "Foundations/Tokens",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Color: Story = {
  render: () => (
    <TokenTable
      prefixes={["--ap-color-", "--ap-tone-"]}
      preview={(name) => (
        <span
          className="inline-block size-6 shrink-0 rounded-control border border-border-strong"
          style={{ background: `var(${name})` }}
        />
      )}
    />
  ),
};

export const Typography: Story = {
  render: () => (
    <TokenTable
      prefixes={["--ap-font-", "--ap-text-", "--ap-weight-", "--ap-leading-"]}
      preview={(name) => {
        if (name.startsWith("--ap-text-"))
          return (
            <span style={{ fontSize: `var(${name})` }}>가나다 Agent 123</span>
          );
        if (name.startsWith("--ap-weight-"))
          return (
            <span style={{ fontWeight: `var(${name})` }}>가나다 Agent</span>
          );
        if (name.startsWith("--ap-font-"))
          return (
            <span style={{ fontFamily: `var(${name})` }}>가나다 Agent 123</span>
          );
        return null;
      }}
    />
  ),
};

export const Spacing: Story = {
  render: () => (
    <TokenTable
      prefixes={["--ap-space-"]}
      preview={(name) => (
        <span
          className="inline-block h-3 shrink-0 bg-primary"
          style={{ width: `var(${name})` }}
        />
      )}
    />
  ),
};

export const Radius: Story = {
  render: () => (
    <TokenTable
      prefixes={["--ap-radius-"]}
      preview={(name) => (
        <span
          className="inline-block h-10 w-16 shrink-0 border-2 border-border-strong bg-muted"
          style={{ borderRadius: `var(${name})` }}
        />
      )}
    />
  ),
};

export const Shadow: Story = {
  render: () => (
    <TokenTable
      prefixes={["--ap-shadow-"]}
      preview={(name) => (
        <span
          className="inline-block h-10 w-16 shrink-0 rounded-card border bg-background"
          style={{ boxShadow: `var(${name})` }}
        />
      )}
    />
  ),
};

/** `prefers-reduced-motion: reduce` sets both durations to 0ms. */
export const Motion: Story = {
  render: () => <TokenTable prefixes={["--ap-motion-"]} />,
};
