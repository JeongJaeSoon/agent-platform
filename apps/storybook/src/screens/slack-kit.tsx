import {
  Button,
  Card,
  CardTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Link,
  RowListItem,
  SearchInput,
  Textarea,
} from "@werft-ai/ui";
import { Check } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

/*
 * Slack console v3 stand-ins (mockups/v3-ia.md §6), shared by the agent
 * detail Slack tab, the new-agent wizard's fifth step and the workspace
 * settings' Slack pages. Each one walks: the scenario stories click through
 * them to their result lines. Kept out of screen-kit.tsx, which the web-ui
 * lead keeps as it is.
 */

/** Another story's canvas, keeping the viewport and theme of this one. */
export function storyHref(id: string): string {
  const globals = new URLSearchParams(globalThis.location?.search ?? "").get(
    "globals",
  );
  return `iframe.html?id=${id}&viewMode=story${globals ? `&globals=${globals}` : ""}`;
}

export const MUTED_TEXT = "text-control text-muted-foreground";
const ACTIONS = "flex flex-wrap items-start justify-end gap-2";

/** A section heading: CardTitle carries the console's 14px semibold title. */
export function Heading({
  id,
  level = 2,
  children,
}: {
  readonly id?: string | undefined;
  readonly level?: 2 | 3;
  readonly children: ReactNode;
}) {
  return (
    <CardTitle id={id} role="heading" aria-level={level}>
      {children}
    </CardTitle>
  );
}

/**
 * Stand-in for `@werft-ai/ui` Switch (SWITCH-SETTINGROW-14, #667): a track
 * and thumb the size of shadcn's Switch (h-5 w-9). The state word sits
 * beside it through SettingRow's `status`.
 */
export function SwitchStandIn({
  checked,
  onCheckedChange,
  labelledBy,
  describedBy,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly labelledBy: string;
  readonly describedBy?: string | undefined;
  readonly disabled?: boolean | undefined;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`h-5 w-9 shrink-0 rounded-full border border-transparent p-0.5 ${checked ? "justify-end bg-primary hover:bg-primary" : "justify-start bg-input hover:bg-input"}`}
    >
      <div className="size-4 rounded-full bg-background shadow-sm" />
    </Button>
  );
}

/**
 * Stand-in for SettingRow inside RowList joined: title and description on
 * the left, the control on the right; below 640px the control goes under
 * the text, right-aligned.
 */
export function SettingRow({
  title,
  description,
  extra,
  status,
  control,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly extra?: ReactNode;
  /** The state word before the control, e.g. 켜짐; not part of its name. */
  readonly status?: ReactNode;
  readonly control?:
    | ((ids: {
        readonly titleId: string;
        readonly descriptionId: string | undefined;
      }) => ReactNode)
    | undefined;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const hasDescription = description !== undefined;
  return (
    <RowListItem className="flex-col items-stretch gap-3 sm:flex-row sm:flex-nowrap sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div id={titleId} className="font-medium text-control leading-5">
          {title}
        </div>
        {hasDescription ? (
          <div id={descriptionId} className={`${MUTED_TEXT} leading-5`}>
            {description}
          </div>
        ) : null}
        {extra}
      </div>
      {control ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 self-end sm:self-auto">
          {status === undefined ? null : (
            <div aria-hidden="true" className={MUTED_TEXT}>
              {status}
            </div>
          )}
          {control({
            titleId,
            descriptionId: hasDescription ? descriptionId : undefined,
          })}
        </div>
      ) : null}
    </RowListItem>
  );
}

/**
 * Stand-in for packages/react DetailRail (V4-RAIL, not landed): the
 * Cloudflare-style right rail, a left rule instead of a card, scrolling on
 * its own. Stacked on narrow pages it takes a top rule. Widths and spacing
 * come from the existing detail layout tokens until V4-RAIL measures them.
 */
export function DetailRailStandIn({
  label,
  narrow,
  children,
}: {
  readonly label: string;
  readonly narrow: boolean;
  readonly children: ReactNode;
}) {
  return (
    <aside
      aria-label={label}
      className={`flex min-w-0 flex-col ${narrow ? "border-t" : "sticky top-0 max-h-dvh self-stretch overflow-y-auto border-l pl-6"}`}
    >
      {children}
    </aside>
  );
}

/** Stand-in for DetailRailSection: a title, then rows, ruled from the next. */
export function DetailRailSectionStandIn({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 border-b py-[var(--ap-space-block)] last:border-b-0"
    >
      <Heading id={titleId}>{title}</Heading>
      {children}
    </section>
  );
}

/** Stand-in for the console's `web-notice` / `web-form__error` result line. */
export function OutcomeStandIn({
  tone = "progress",
  children,
}: {
  readonly tone?: "progress" | "danger";
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A result line takes focus when it appears, as the console's does.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Card
      ref={ref}
      tabIndex={-1}
      data-tone={tone}
      role={tone === "danger" ? "alert" : "status"}
      data-outcome=""
      className="border-(color:--ap-tone-border) bg-(color:--ap-tone-bg) px-4 py-3 text-(color:--ap-tone-fg) outline-none"
    >
      {children}
    </Card>
  );
}

/** Stand-in for the console's ALERT block: a stop to read before going on. */
export function AlertCard({
  title,
  tone = "attention",
  level = 3,
  children,
}: {
  readonly title: ReactNode;
  readonly tone?: "attention" | "danger";
  readonly level?: 2 | 3;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  return (
    <Card
      role="region"
      aria-labelledby={titleId}
      className={`items-start gap-2 p-4 ${tone === "danger" ? "border-(color:--ap-tone-danger-border)" : "border-(color:--ap-tone-attention-border)"}`}
    >
      <Heading id={titleId} level={level}>
        {title}
      </Heading>
      {children}
    </Card>
  );
}

/** A disabled button that says why, as the console's ReasonButton does. */
export function ReasonButton({
  label,
  reason,
}: {
  readonly label: string;
  readonly reason: string;
}) {
  const reasonId = useId();
  return (
    <div className="inline-flex flex-col items-end gap-1">
      <Button type="button" disabled aria-describedby={reasonId}>
        {label}
      </Button>
      <div id={reasonId} className="text-caption text-muted-foreground">
        {reason}
      </div>
    </div>
  );
}

export interface ChannelOption {
  readonly name: string;
  readonly note: string;
  /** A private channel still waiting for approval cannot be picked. */
  readonly disabled?: boolean | undefined;
}

export interface ChannelGroup {
  readonly label: string;
  readonly options: readonly ChannelOption[];
}

const CHANNEL_PAGE = 5;

/**
 * Stand-in for the channel Combobox: a search field over an always-open
 * listbox. Typing filters the fixed demo channels by name; the list shows
 * CHANNEL_PAGE matches at a time and "더 보기" adds the next page. How the
 * product fetches the matches is not drawn here.
 */
export function ChannelCombobox({
  label,
  groups,
  value,
  onChange,
  description,
}: {
  readonly label: string;
  readonly groups: readonly ChannelGroup[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly description?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(CHANNEL_PAGE);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const optionId = useId();
  const hintId = useId();
  const needle = query.trim().replace(/^#/, "").toLowerCase();
  // Each note already says 공개 or 비공개, so the group label is not repeated.
  const matches = groups.flatMap((group) =>
    group.options.filter((option) =>
      option.name.replace(/^#/, "").toLowerCase().includes(needle),
    ),
  );
  const visible = matches.slice(0, shown);
  const pick = (index: number) => {
    const option = visible[index];
    if (!option || option.disabled) return;
    onChange(option.name);
    setActive(index);
  };
  const search = (next: string) => {
    setQuery(next);
    setShown(CHANNEL_PAGE);
    setActive(-1);
  };
  return (
    <Field>
      <FieldLabel htmlFor={`${listId}-input`}>{label}</FieldLabel>
      <SearchInput
        id={`${listId}-input`}
        role="combobox"
        aria-label={`${label} 검색`}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          active >= 0 && active < visible.length
            ? `${optionId}-${active}`
            : undefined
        }
        aria-describedby={hintId}
        placeholder="채널 이름으로 검색"
        autoComplete="off"
        wrapperClassName="max-w-none flex-none"
        value={query}
        onChange={(event) => search(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((current) =>
              Math.min(Math.max(current + step, 0), visible.length - 1),
            );
          } else if (event.key === "Enter" && active >= 0) {
            event.preventDefault();
            pick(active);
          }
        }}
      />
      <div className="flex flex-col rounded-md border">
        <div
          id={listId}
          role="listbox"
          aria-label={`${label} 후보`}
          className="flex flex-col p-1"
        >
          {visible.map((option, index) => (
            <Button
              key={option.name}
              id={`${optionId}-${index}`}
              type="button"
              variant="ghost"
              role="option"
              tabIndex={-1}
              aria-selected={option.name === value}
              aria-disabled={option.disabled || undefined}
              data-active={index === active || undefined}
              onClick={() => pick(index)}
              className="h-auto justify-between gap-3 px-2 py-2 text-left font-normal aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-selected:bg-accent data-active:bg-accent"
            >
              <div className="flex min-w-0 flex-col">
                <div className="font-medium">{option.name}</div>
                <div className="text-caption text-muted-foreground">
                  {option.note}
                </div>
              </div>
              {option.name === value ? (
                <Check aria-hidden="true" strokeWidth={1.5} />
              ) : null}
            </Button>
          ))}
        </div>
        {matches.length === 0 ? (
          <div className={`${MUTED_TEXT} px-3 pb-2.5`}>
            맞는 채널이 없습니다.
          </div>
        ) : null}
        {matches.length > shown ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-t-none border-t"
            onClick={() => setShown((current) => current + CHANNEL_PAGE)}
          >
            더 보기 ({matches.length - shown}개 남음)
          </Button>
        ) : null}
      </div>
      <FieldDescription id={hintId}>
        {value ? `고른 채널: ${value}` : "아직 고르지 않았습니다."}
        {description ? ` ${description}` : ""}
      </FieldDescription>
    </Field>
  );
}

export type ConnectStep =
  | "allow"
  | "pick"
  | "done"
  | "later"
  | "error"
  | "blocked";

export const HOME_CHANNEL_HINT =
  "봇이 인사하고 멘션에 답하는 채널입니다. 공개 채널은 고르면 봇이 참여해 인사를 1건 보냅니다. 비공개 채널은 그 채널에서 /invite로 초대하고 승인한 뒤에 고를 수 있습니다.";

/**
 * Connecting an agent to Slack: allow, pick the home channel, the result
 * (v3-ia §3.3). The wizard's fifth step and the Slack tab of an agent that
 * is not connected yet. The system steps (app, event URL, welcome) show
 * only when one fails.
 */
export function SlackConnectCard({
  step,
  wizard,
  bot,
  channels,
  description,
  home,
  onStep,
  skipHref,
  agentHref,
  settingsHref,
}: {
  readonly step: ConnectStep;
  readonly wizard: boolean;
  readonly bot: string;
  readonly channels: readonly ChannelGroup[];
  readonly description: string;
  /** The home channel the "done" step reports. */
  readonly home: string;
  /** `picked` is the chosen home channel when the step is "done". */
  readonly onStep: (next: ConnectStep | "allowed", picked?: string) => void;
  readonly skipHref?: string | undefined;
  readonly agentHref?: string | undefined;
  readonly settingsHref?: string | undefined;
}) {
  const [picked, setPicked] = useState("");
  const headingId = useId();
  const later = wizard ? (
    <Button asChild variant="ghost">
      <a href={skipHref}>나중에 하기</a>
    </Button>
  ) : null;
  const toAgent = wizard ? (
    <Button asChild>
      <a href={agentHref}>에이전트 보기</a>
    </Button>
  ) : null;
  const body = {
    allow: (
      <>
        <div className={MUTED_TEXT}>
          이 에이전트의 Slack 앱을 만들어 워크스페이스에 설치합니다. Slack
          화면에서 허용을 누르면 이 화면으로 돌아옵니다.
          {wizard
            ? " 건너뛰어도 에이전트의 Slack 탭에서 나중에 연결할 수 있습니다."
            : ""}
        </div>
        <Field>
          <FieldLabel>Slack에 보이는 설명</FieldLabel>
          <Textarea rows={2} maxLength={300} defaultValue={description} />
          <FieldDescription>
            카드의 역할에서 채웠습니다. 300자까지 씁니다.
          </FieldDescription>
        </Field>
        <div className={ACTIONS}>
          {later}
          <Button type="button" onClick={() => onStep("allowed")}>
            Slack에 설치
          </Button>
        </div>
      </>
    ),
    blocked: (
      <>
        <AlertCard title="App Configuration Token이 없습니다">
          <div>
            Slack 앱을 만들려면 워크스페이스에 token이 하나 있어야 합니다.
            워크스페이스 설정의 Slack 연결 설정에서 소유자나 관리자가
            저장합니다.
          </div>
          <Link href={settingsHref} underline="always">
            워크스페이스 설정으로
          </Link>
        </AlertCard>
        <div className={ACTIONS}>
          {later}
          <ReasonButton
            label="Slack에 설치"
            reason="token이 저장되면 누를 수 있습니다"
          />
        </div>
      </>
    ),
    pick: (
      <>
        <OutcomeStandIn>Slack에 설치했습니다 · {bot}</OutcomeStandIn>
        <ChannelCombobox
          label="홈 채널"
          groups={channels}
          value={picked}
          onChange={setPicked}
          description={HOME_CHANNEL_HINT}
        />
        <div className={ACTIONS}>
          <Button type="button" variant="ghost" onClick={() => onStep("later")}>
            나중에 고르기
          </Button>
          {picked ? (
            <Button type="button" onClick={() => onStep("done", picked)}>
              홈 채널로 정하기
            </Button>
          ) : (
            <ReasonButton
              label="홈 채널로 정하기"
              reason="채널을 고르면 누를 수 있습니다"
            />
          )}
        </div>
      </>
    ),
    done: (
      <>
        <OutcomeStandIn>
          연결됨 · {bot} · {home}. {home}에 인사를 1건 보냈습니다.
        </OutcomeStandIn>
        {toAgent ? <div className={ACTIONS}>{toAgent}</div> : null}
      </>
    ),
    later: (
      <>
        <OutcomeStandIn>
          Slack 설치됨 · 홈 채널 미선택. 홈 채널을 고를 때까지 봇은 어느
          채널에도 인사하지 않습니다.
        </OutcomeStandIn>
        <div className={ACTIONS}>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setPicked("");
              onStep("pick");
            }}
          >
            홈 채널 선택
          </Button>
          {toAgent}
        </div>
      </>
    ),
    error: (
      <>
        <AlertCard tone="danger" title="이벤트 주소를 등록하지 못했습니다">
          <div>
            Slack 앱 만들기와 설치는 끝났습니다. 이벤트 주소를 등록하는 동안
            Slack이 응답하지 않았습니다(timeout). 다시 시도하면 끝난 단계는
            건너뜁니다.
          </div>
        </AlertCard>
        <div className={ACTIONS}>
          {later}
          <Button type="button" onClick={() => onStep("pick")}>
            다시 시도
          </Button>
        </div>
      </>
    ),
  }[step];
  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      className="w-full gap-4 p-4"
    >
      <Heading id={headingId}>{wizard ? "Slack 연결" : "Slack에 연결"}</Heading>
      {body}
    </Card>
  );
}
