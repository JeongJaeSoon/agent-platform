import type { Meta, StoryObj } from "@storybook/react-vite";
import { CopyButton, type CopyButtonProps, FieldError } from "@werft-ai/ui";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    label: "복사",
    copiedLabel: "복사됨",
    iconName: "키 ID 복사",
    failed: "복사하지 못했습니다. 값을 선택해 직접 복사하세요.",
  },
  ja: {
    label: "コピー",
    copiedLabel: "コピー済み",
    iconName: "キー ID をコピー",
    failed: "コピーできませんでした。値を選択して手動でコピーしてください。",
  },
  en: {
    label: "Copy",
    copiedLabel: "Copied",
    iconName: "Copy key ID",
    failed: "Could not copy. Select the value and copy it yourself.",
  },
} as const;

type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return () => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  };
}

const accept = () => stubClipboard(async () => {});
const refuse = () =>
  stubClipboard(async () => {
    throw new Error("denied");
  });

// Fake value only.
const KEY_ID = "ak_01FAKE0000000000000000STORY";

/** The screen draws its own failure line from `onResult`, as apps/web does. */
function WithOutcome({
  failedMessage,
  ...props
}: CopyButtonProps & { readonly failedMessage: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col items-start gap-2">
      <CopyButton {...props} onResult={(ok) => setFailed(!ok)} />
      {failed ? <FieldError>{failedMessage}</FieldError> : null}
    </div>
  );
}

const meta = {
  title: "Patterns/CopyButton",
  component: CopyButton,
  args: { value: KEY_ID, variant: "outline", size: "sm" },
  render: (args, context) => {
    const copy = copyFor(context);
    return (
      <WithOutcome
        {...args}
        label={copy.label}
        copiedLabel={copy.copiedLabel}
        failedMessage={copy.failed}
      />
    );
  },
} satisfies Meta<typeof CopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

/** The clipboard took the value: Check and the copied text replace Copy. */
export const Copied: Story = {
  beforeEach: accept,
  play: async ({ canvasElement, globals }) => {
    const canvas = within(canvasElement);
    const copy = copyFor({ globals });
    const button = canvas.getByRole("button", { name: copy.label });
    await userEvent.click(button);
    await expect(
      await canvas.findByRole("button", { name: copy.copiedLabel }),
    ).toHaveAttribute("data-copied");
  },
};

export const CopiedDark: Story = {
  ...Copied,
  name: "Copied (dark)",
  globals: { theme: "dark" },
};

/** The clipboard refused: the button stays as it was and the screen says so. */
export const CopyFailed: Story = {
  beforeEach: refuse,
  play: async ({ canvasElement, globals }) => {
    const canvas = within(canvasElement);
    const copy = copyFor({ globals });
    await userEvent.click(canvas.getByRole("button", { name: copy.label }));
    await expect(await canvas.findByText(copy.failed)).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: copy.label }),
    ).not.toHaveAttribute("data-copied");
  },
};

export const CopyFailedDark: Story = {
  ...CopyFailed,
  name: "Copy failed (dark)",
  globals: { theme: "dark" },
};

/**
 * Icon only, named by `aria-label` (the API key ID). The icon turns into a
 * Check and a hidden status announces the copy. No visible copied text: it
 * would not be part of the fixed name.
 */
export const IconOnlyCopied: Story = {
  name: "Icon only, copied",
  args: { variant: "ghost", size: "icon-sm" },
  render: (args, context) => {
    const copy = copyFor(context);
    return (
      <span className="inline-flex items-center gap-1 text-caption text-subtle-foreground">
        <span className="font-mono">{KEY_ID}</span>
        <CopyButton
          {...args}
          aria-label={copy.iconName}
          copiedMessage={copy.copiedLabel}
        />
      </span>
    );
  },
  beforeEach: accept,
  play: async ({ canvasElement, globals }) => {
    const canvas = within(canvasElement);
    const copy = copyFor({ globals });
    await userEvent.click(canvas.getByRole("button", { name: copy.iconName }));
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      copy.copiedLabel,
    );
  },
};

export const IconOnlyCopiedMobile: Story = {
  ...IconOnlyCopied,
  name: "Icon only, copied (390px)",
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};
