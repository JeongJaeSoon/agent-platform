import type { Meta, StoryObj } from "@storybook/react-vite";
import { LoadMoreButton } from "@werft-ai/react/components";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Button,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
} from "@werft-ai/ui";
import { useState } from "react";

import { MOBILE } from "../../screens/screen-kit.tsx";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    more: "더 보기",
    loading: "불러오는 중…",
    table: "구성원",
    name: "이름",
    open: (name: string) => `${name} 편집`,
    failed: "불러오지 못했습니다",
    failedText: "잠시 후 다시 시도하세요.",
    retry: "다시 시도",
  },
  ja: {
    more: "さらに表示",
    loading: "読み込み中…",
    table: "メンバー",
    name: "名前",
    open: (name: string) => `${name}を編集`,
    failed: "読み込めませんでした",
    failedText: "しばらくしてからもう一度お試しください。",
    retry: "再試行",
  },
  en: {
    more: "Show more",
    loading: "Loading…",
    table: "Members",
    name: "Name",
    open: (name: string) => `Edit ${name}`,
    failed: "Couldn't load",
    failedText: "Try again in a moment.",
    retry: "Try again",
  },
} as const;

type Copy = (typeof COPY)[keyof typeof COPY];
type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals): Copy {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

const PAGE = 3;
const TOTAL = 7;
const DELAY_MS = 800;

/** A paged list as the console draws it, starting in `start`. */
function PagedList({
  copy,
  start = "idle",
}: {
  readonly copy: Copy;
  readonly start?: "idle" | "loading" | "failed";
}) {
  const [shown, setShown] = useState(PAGE);
  const [state, setState] = useState(start);
  const load = () => {
    setState("loading");
    setTimeout(() => {
      setShown((count) => Math.min(TOTAL, count + PAGE));
      setState("idle");
    }, DELAY_MS);
  };
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="rounded-card border bg-card">
        <GridTable aria-label={copy.table} columns="minmax(0,1fr)">
          <GridTableHeader>
            <GridTableColumnHeader>{copy.name}</GridTableColumnHeader>
          </GridTableHeader>
          {Array.from({ length: shown }, (_, index) => `Person ${index}`).map(
            (name) => (
              <GridTableRow key={name}>
                <GridTableCell>
                  <GridTableRowOpener aria-label={copy.open(name)} />
                  {name}
                </GridTableCell>
              </GridTableRow>
            ),
          )}
        </GridTable>
      </div>
      {state === "failed" ? (
        <Alert variant="red" role="alert">
          <AlertTitle>{copy.failed}</AlertTitle>
          <AlertDescription>{copy.failedText}</AlertDescription>
          <AlertActions>
            <Button type="button" variant="outline" size="sm" onClick={load}>
              {copy.retry}
            </Button>
          </AlertActions>
        </Alert>
      ) : null}
      <LoadMoreButton
        hasMore={shown < TOTAL}
        loading={state === "loading"}
        onLoadMore={load}
        messages={{ more: copy.more, loading: copy.loading }}
      />
    </div>
  );
}

const meta = {
  title: "Domain/List/LoadMoreButton",
  component: LoadMoreButton,
  args: {
    hasMore: true,
    loading: false,
    onLoadMore: () => {},
    messages: { more: COPY.ko.more, loading: COPY.ko.loading },
  },
} satisfies Meta<typeof LoadMoreButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The next page is on its way: aria-disabled, so the keyboard stays on it. */
export const Loading: Story = {
  args: {
    loading: true,
    messages: { more: COPY.ko.more, loading: COPY.ko.loading },
  },
};

/**
 * Pages on with Enter: the focus stays on the button between pages and moves
 * to the first new row when the last page takes the button away.
 */
export const InList: Story = {
  render: (_args, context) => <PagedList copy={copyFor(context)} />,
};

/** A next page that failed keeps the button, with the alert above it. */
export const Failed: Story = {
  render: (_args, context) => (
    <PagedList copy={copyFor(context)} start="failed" />
  ),
};

export const InListEnglish: Story = {
  ...InList,
  name: "In list (en)",
  globals: { locale: "en" },
};

export const InListJapanese: Story = {
  ...InList,
  name: "In list (ja)",
  globals: { locale: "ja" },
};

export const FailedDark: Story = {
  ...Failed,
  name: "Failed (dark)",
  globals: { theme: "dark" },
};

export const InListMobile: Story = { ...InList, globals: MOBILE };
