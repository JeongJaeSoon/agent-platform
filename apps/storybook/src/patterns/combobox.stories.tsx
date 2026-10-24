import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Combobox,
  type ComboboxOption,
  Field,
  FieldDescription,
  FieldLabel,
} from "@werft-ai/ui";
import { useEffect, useRef, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    member: "추가할 구성원",
    memberHint: "이미 팀에 있는 사람은 고를 수 없습니다.",
    memberPlaceholder: "이름이나 이메일로 찾기",
    channel: "연결할 채널",
    channelPlaceholder: "채널 이름으로 찾기",
    public: "공개 채널",
    private: "비공개 채널",
    publicTag: "공개",
    privateTag: "비공개",
    invited: "봇 초대됨 · 승인 대기",
    empty: "맞는 결과가 없습니다.",
    loading: "불러오는 중…",
    loadMore: "더 보기",
    count: (count: number) => `결과 ${count}개`,
  },
  ja: {
    member: "追加するメンバー",
    memberHint: "すでにチームにいる人は選べません。",
    memberPlaceholder: "名前かメールで検索",
    channel: "接続するチャンネル",
    channelPlaceholder: "チャンネル名で検索",
    public: "公開チャンネル",
    private: "非公開チャンネル",
    publicTag: "公開",
    privateTag: "非公開",
    invited: "ボット招待済み · 承認待ち",
    empty: "一致する結果はありません。",
    loading: "読み込み中…",
    loadMore: "さらに表示",
    count: (count: number) => `${count} 件の結果`,
  },
  en: {
    member: "Member to add",
    memberHint: "People already on the team can't be picked.",
    memberPlaceholder: "Search by name or email",
    channel: "Channel to connect",
    channelPlaceholder: "Search channels",
    public: "Public channel",
    private: "Private channel",
    publicTag: "Public",
    privateTag: "Private",
    invited: "Bot invited · awaiting approval",
    empty: "No matches.",
    loading: "Loading…",
    loadMore: "Load more",
    count: (count: number) => `${count} results`,
  },
} as const;

type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

// Fake people only.
const PEOPLE = [
  ["Kim Minji", "minji.kim@example.com"],
  ["Lee Junho", "junho.lee@example.com"],
  ["Park Sora", "sora.park@example.com"],
  ["Choi Dana", "dana.choi@example.com"],
  ["Jung Hana", "hana.jung@example.com"],
  ["Kang Yuna", "yuna.kang@example.com"],
  ["Yoon Seojin", "seojin.yoon@example.com"],
  ["Han Jiwoo", "jiwoo.han@example.com"],
  ["Sato Haruka", "haruka.sato@example.com"],
  ["Tanaka Ren", "ren.tanaka@example.com"],
  ["Alex Morgan", "alex.morgan@example.com"],
  ["Sam Rivera", "sam.rivera@example.com"],
] as const;
const ON_TEAM = new Set(["Lee Junho", "Jung Hana"]);

const MEMBERS: ComboboxOption[] = PEOPLE.map(([name, email], index) => ({
  value: `usr_${index}`,
  label: name,
  description: email,
  disabled: ON_TEAM.has(name),
}));

const CHANNELS = [
  ["general", false],
  ["release-notes", false],
  ["incident-war-room", true],
  ["agent-platform-dev", false],
  ["leadership", true],
  ["support-escalations", false],
  ["design-review", false],
  ["random", false],
  ["deploys", false],
  ["security-alerts", true],
  ["onboarding", false],
  ["customer-feedback", false],
  ["data-platform", false],
] as const;
const CONNECTED = new Set(["general", "deploys"]);
// A name too long for 390px, so its line ends in an ellipsis before the tag.
const LONG_CHANNEL = "customer-success-escalations-apac-weekend-oncall";
// With a second line, so the tag must still sit on the name's line.
const INVITED_CHANNEL = "incident-war-room";
const PAGE = 5;
const LATENCY_MS = 600;

interface ChannelPage {
  readonly items: readonly (typeof CHANNELS)[number][];
  readonly next: number | null;
}

/** Stands in for a channel search API with `q` and a cursor; none exists yet. */
function fetchChannels(q: string, cursor: number): Promise<ChannelPage> {
  const matched = CHANNELS.filter(([name]) => name.includes(q.toLowerCase()));
  const items = matched.slice(cursor, cursor + PAGE);
  const next = cursor + PAGE < matched.length ? cursor + PAGE : null;
  return new Promise((resolve) =>
    setTimeout(() => resolve({ items, next }), LATENCY_MS),
  );
}

type Copy = ReturnType<typeof copyFor>;

function MemberPicker({
  copy,
  options = MEMBERS,
}: {
  readonly copy: Copy;
  readonly options?: readonly ComboboxOption[];
}) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <div className="max-w-105">
      <Field>
        <FieldLabel>{copy.member}</FieldLabel>
        <Combobox
          options={options}
          value={value}
          onValueChange={setValue}
          placeholder={copy.memberPlaceholder}
          emptyMessage={copy.empty}
          resultCountMessage={copy.count}
        />
        <FieldDescription>{copy.memberHint}</FieldDescription>
      </Field>
    </div>
  );
}

/** Visibility as a tag at the end of the name's line, not a second line. */
function ChannelTagPicker({ copy }: { readonly copy: Copy }) {
  const [value, setValue] = useState<string | null>(null);
  const options: ComboboxOption[] = [
    [LONG_CHANNEL, false] as const,
    ...CHANNELS,
  ].map(([name, isPrivate]) => ({
    value: name,
    label: `#${name}`,
    end: (
      <Badge variant="gray">
        {isPrivate ? copy.privateTag : copy.publicTag}
      </Badge>
    ),
    ...(name === INVITED_CHANNEL ? { description: copy.invited } : {}),
    disabled: CONNECTED.has(name),
  }));
  return (
    <div className="max-w-105">
      <Combobox
        aria-label={copy.channel}
        placeholder={copy.channelPlaceholder}
        options={options}
        value={value}
        onValueChange={setValue}
        emptyMessage={copy.empty}
        resultCountMessage={copy.count}
      />
    </div>
  );
}

/*
 * The caller owns the server search: it debounces through the kit, pages with
 * the cursor and drops a response that a newer request or newer typing has
 * overtaken, even before the debounce sends the new query.
 */
function ChannelPicker({ copy }: { readonly copy: Copy }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ChannelPage["items"]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const typed = useRef("");

  function load(q: string, cursor: number) {
    const request = ++latest.current;
    setLoading(true);
    void fetchChannels(q, cursor).then((page) => {
      if (request !== latest.current || q !== typed.current) return;
      setItems((current) =>
        cursor === 0 ? page.items : [...current, ...page.items],
      );
      setNext(page.next);
      setLoading(false);
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the first page, once; load touches only a ref and setters.
  useEffect(() => load("", 0), []);

  const options: ComboboxOption[] = items.map(([name, isPrivate]) => ({
    value: name,
    label: `#${name}`,
    description: isPrivate ? copy.private : copy.public,
    disabled: CONNECTED.has(name),
  }));

  return (
    <div className="max-w-105">
      <Combobox
        aria-label={copy.channel}
        placeholder={copy.channelPlaceholder}
        clearOnSelect
        options={options}
        filter="none"
        onInputValueChange={(text) => {
          typed.current = text;
          if (text !== query) setLoading(true);
        }}
        onQueryChange={(q) => {
          setQuery(q);
          load(q, 0);
        }}
        loading={loading}
        loadingMessage={copy.loading}
        hasMore={next !== null}
        onLoadMore={() => {
          if (next !== null) load(query, next);
        }}
        loadMoreLabel={copy.loadMore}
        emptyMessage={copy.empty}
        resultCountMessage={copy.count}
      />
    </div>
  );
}

const meta = {
  title: "Patterns/Combobox",
  component: Combobox,
  args: { options: MEMBERS, emptyMessage: COPY.ko.empty },
  render: (_args, context) => <MemberPicker copy={copyFor(context)} />,
} satisfies Meta<typeof Combobox>;

export default meta;
type Story = StoryObj<typeof meta>;

// The list is portalled to <body>, outside the canvas.
const page = () => within(document.body);

async function openWithArrow(canvasElement: HTMLElement) {
  const box = within(canvasElement).getByRole("combobox");
  await userEvent.click(box);
  await userEvent.keyboard("{ArrowDown}");
  await expect(box).toHaveAttribute("aria-expanded", "true");
  return box;
}

/**
 * Team members filtered in the browser: name or email, two already on the
 * team shown but not choosable. The label comes from the Field.
 */
export const InternalFilter: Story = {
  play: async ({ canvasElement }) => {
    const box = await openWithArrow(canvasElement);
    await userEvent.type(box, "an");
    const options = page().getAllByRole("option");
    await expect(options.length).toBeLessThan(MEMBERS.length);
    await expect(
      options.some((option) => option.getAttribute("aria-disabled")),
    ).toBe(true);
  },
};

/** Keyboard: open, move, skip the disabled one, pick. */
export const KeyboardPick: Story = {
  play: async ({ canvasElement }) => {
    const box = await openWithArrow(canvasElement);
    const active = () =>
      document.getElementById(box.getAttribute("aria-activedescendant") ?? "");
    await expect(active()).toHaveTextContent("Kim Minji");
    // Lee Junho is on the team; the next stop is Park Sora.
    await userEvent.keyboard("{ArrowDown}");
    await expect(active()).toHaveTextContent("Park Sora");
    await userEvent.keyboard("{Enter}");
    await expect(box).toHaveAttribute("aria-expanded", "false");
    await expect(box).toHaveValue("Park Sora");
  },
};

export const InternalFilterDark: Story = {
  ...InternalFilter,
  name: "Internal filter (dark)",
  globals: { theme: "dark" },
};

export const InternalFilterMobile: Story = {
  ...InternalFilter,
  name: "Internal filter (390px)",
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};

export const InternalFilterEnglish: Story = {
  ...InternalFilter,
  name: "Internal filter (en)",
  globals: { locale: "en" },
};

/**
 * Each channel's visibility tag sits at the end of its name's line; a name too
 * long for the row is cut with an ellipsis and the tag stays whole.
 */
export const EndTag: Story = {
  render: (_args, context) => <ChannelTagPicker copy={copyFor(context)} />,
  play: async ({ canvasElement, globals }) => {
    const copy = copyFor({ globals });
    await openWithArrow(canvasElement);
    const options = page().getAllByRole("option");
    const parts = (name: string) => {
      const option = options.find((o) => o.textContent?.startsWith(`#${name}`));
      const [text, end] = Array.from(option?.children ?? []) as HTMLElement[];
      return { option, label: text?.querySelector("span"), end };
    };
    const middle = (el: Element | null | undefined) => {
      const box = el?.getBoundingClientRect();
      return box ? box.top + box.height / 2 : Number.NaN;
    };
    // Numbers and booleans, not elements: the play log serialises what
    // expect gets.
    const long = parts(LONG_CHANNEL);
    await expect(long.end?.textContent).toBe(copy.publicTag);
    await expect(
      Boolean(
        long.label &&
          getComputedStyle(long.label).textOverflow === "ellipsis" &&
          long.label.scrollWidth > long.label.clientWidth,
      ),
    ).toBe(true);
    const tag = long.end?.getBoundingClientRect();
    const row = long.option?.getBoundingClientRect();
    const name = long.label?.getBoundingClientRect();
    await expect(
      Boolean(
        tag &&
          row &&
          name &&
          long.end &&
          tag.right <= row.right &&
          name.right <= tag.left &&
          long.end.scrollWidth <= Math.ceil(tag.width),
      ),
    ).toBe(true);
    await expect(Math.abs(middle(long.end) - middle(long.label)) <= 1).toBe(
      true,
    );
    const invited = parts(INVITED_CHANNEL);
    await expect(invited.end?.textContent).toBe(copy.privateTag);
    await expect(
      Math.abs(middle(invited.end) - middle(invited.label)) <= 1,
    ).toBe(true);
  },
};

export const EndTagMobile: Story = {
  ...EndTag,
  name: "End tag (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const EndTagDark: Story = {
  ...EndTag,
  name: "End tag (dark)",
  globals: { theme: "dark" },
};

/** Search on the server: loading, results, then the next page. */
export const ServerSearch: Story = {
  render: (_args, context) => <ChannelPicker copy={copyFor(context)} />,
  play: async ({ canvasElement, globals }) => {
    const copy = copyFor({ globals });
    await openWithArrow(canvasElement);
    // Counts, not the elements: the play log serialises what expect gets.
    // Each page is five channels plus the "load more" row.
    await waitFor(() => expect(page().getAllByRole("option").length).toBe(6));
    await userEvent.click(page().getByRole("option", { name: copy.loadMore }));
    await expect(page().getByRole("listbox")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await waitFor(() => expect(page().getAllByRole("option").length).toBe(11));
  },
};

export const ServerSearchDark: Story = {
  ...ServerSearch,
  name: "Server search (dark)",
  globals: { theme: "dark" },
};

/** A query that matches nothing on the server. */
export const ServerSearchEmpty: Story = {
  render: (_args, context) => <ChannelPicker copy={copyFor(context)} />,
  play: async ({ canvasElement, globals }) => {
    const copy = copyFor({ globals });
    const box = await openWithArrow(canvasElement);
    await userEvent.type(box, "zzz");
    await expect(
      await page().findByText(copy.empty, { selector: "p" }),
    ).toBeVisible();
  },
};

export const Empty: Story = {
  play: async ({ canvasElement, globals }) => {
    const copy = copyFor({ globals });
    const box = within(canvasElement).getByRole("combobox");
    await userEvent.type(box, "nobody-here");
    await expect(
      await page().findByText(copy.empty, { selector: "p" }),
    ).toBeVisible();
  },
};

/** Options without a second line keep the 40px row. */
export const OneLine: Story = {
  render: (_args, context) => {
    const copy = copyFor(context);
    return (
      <div className="max-w-105">
        <Combobox
          aria-label={copy.channel}
          options={CHANNELS.map(([name]) => ({
            value: name,
            label: `#${name}`,
            disabled: CONNECTED.has(name),
          }))}
          emptyMessage={copy.empty}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    await openWithArrow(canvasElement);
    await expect(page().getAllByRole("option").length).toBe(CHANNELS.length);
  },
};

/** Everyone is already on the team: arrows have nowhere to go. */
export const AllDisabled: Story = {
  render: (_args, context) => (
    <MemberPicker
      copy={copyFor(context)}
      options={MEMBERS.map((option) => ({ ...option, disabled: true }))}
    />
  ),
  play: async ({ canvasElement }) => {
    const box = await openWithArrow(canvasElement);
    await expect(box).not.toHaveAttribute("aria-activedescendant");
  },
};
