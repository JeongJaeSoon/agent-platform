import type { Meta, StoryObj } from "@storybook/react-vite";
import { SecretField } from "@werft-ai/ui";
import { expect, userEvent, within } from "storybook/test";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    copyLabel: "복사",
    copiedMessage: "복사했습니다.",
    copyFailedMessage:
      "복사하지 못했습니다. 값을 선택해 두었으니 직접 복사하세요.",
  },
  ja: {
    copyLabel: "コピー",
    copiedMessage: "コピーしました。",
    copyFailedMessage:
      "コピーできませんでした。値を選択したので手動でコピーしてください。",
  },
  en: {
    copyLabel: "Copy",
    copiedMessage: "Copied.",
    copyFailedMessage:
      "Could not copy. The value is selected; copy it yourself.",
  },
} as const;

type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

function restoreClipboard(original: PropertyDescriptor | undefined) {
  if (original) Object.defineProperty(navigator, "clipboard", original);
  else Reflect.deleteProperty(navigator, "clipboard");
}

// Fake values only.
const WORKSPACE_ID = "ws_01FAKE0000000000000000STORY";
const LONG_SECRET = `apk_fake_${"0123456789abcdef".repeat(6)}`;

const meta = {
  title: "Patterns/SecretField",
  component: SecretField,
  args: {
    value: WORKSPACE_ID,
    ...COPY.ko,
  },
  render: (args, context) => (
    <div className="max-w-105">
      <SecretField {...args} {...copyFor(context)} />
    </div>
  ),
} satisfies Meta<typeof SecretField>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The caller sets the 420px cap (mockup v4 workspace ID). */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

/** A key shown once: an unbroken value wraps inside the box. */
export const LongValue: Story = { args: { value: LONG_SECRET } };

export const LongValueMobile: Story = {
  name: "Long value (390px)",
  args: { value: LONG_SECRET },
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};

/** The clipboard took the value: the result stays under the box. */
export const Copied: Story = {
  beforeEach: () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    });
    return () => restoreClipboard(original);
  },
  play: async ({ canvasElement, globals }) => {
    const canvas = within(canvasElement);
    const copy = copyFor({ globals });
    await userEvent.click(canvas.getByRole("button", { name: copy.copyLabel }));
    await expect(await canvas.findByText(copy.copiedMessage)).toBeVisible();
  },
};

/** The clipboard refused: the failure stays visible and the value selected. */
export const CopyFailed: Story = {
  beforeEach: () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    return () => restoreClipboard(original);
  },
  play: async ({ canvasElement, globals }) => {
    const canvas = within(canvasElement);
    const copy = copyFor({ globals });
    await userEvent.click(canvas.getByRole("button", { name: copy.copyLabel }));
    await expect(await canvas.findByText(copy.copyFailedMessage)).toBeVisible();
  },
};

export const CopyFailedDark: Story = {
  ...CopyFailed,
  name: "Copy failed (dark)",
  globals: { theme: "dark" },
};
