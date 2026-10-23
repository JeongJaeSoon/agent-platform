import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { KitSample } from "./kit-sample.tsx";
import css from "./no-preflight.css?inline";

/*
 * The design's §4.2 risk: a host without Tailwind's preflight (the prebuilt
 * stylesheet ships without it) must still draw the kit as the console does.
 * A shadow root keeps the page's preflight out, and no-preflight.css loads
 * what the prebuilt stylesheet carries instead.
 */
function WithoutPreflight({ children }: { readonly children: ReactNode }) {
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  const attach = useCallback((host: HTMLDivElement | null) => {
    if (!host || host.shadowRoot) return;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    shadow.append(style);
    setRoot(shadow);
  }, []);
  return <div ref={attach}>{root ? createPortal(children, root) : null}</div>;
}

const meta = {
  title: "Foundations/No preflight",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <WithoutPreflight>
      <KitSample />
    </WithoutPreflight>
  ),
};

export const DefaultDark: Story = {
  ...Default,
  name: "Default (dark)",
  globals: { theme: "dark" },
};
