import {
  Badge,
  Button,
  Card,
  CardTitle,
  Combobox,
  type ComboboxOption,
  Field,
  FieldDescription,
  FieldLabel,
  Link,
  Textarea,
} from "@werft-ai/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { PartRequest } from "./screen-kit.tsx";

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

/**
 * Slack only names the private channels the bot is in (groups:read), so a
 * private option is one the bot was invited to.
 */
export interface ChannelOption {
  readonly name: string;
  readonly private?: boolean | undefined;
  /** A private channel still waiting for approval cannot be picked. */
  readonly disabled?: boolean | undefined;
}

export interface ChannelGroup {
  readonly label: string;
  readonly options: readonly ChannelOption[];
}

const CHANNEL_PAGE = 5;

/**
 * Picks one channel with the kit's Combobox. The story pages through fixed
 * demo channels the way a server search would (a query, CHANNEL_PAGE at a
 * time, "더 보기"), so it filters itself (`filter="none"`): the kit's own
 * filter would only see the pages already loaded. The rows carry only a
 * 공개/비공개 tag; what picking does is said once, above or below the list.
 */
export function ChannelCombobox({
  label,
  groups,
  value,
  onChange,
  hint,
  privateHint,
}: {
  readonly label: string;
  readonly groups: readonly ChannelGroup[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Above the list; a dialog that already says it leaves this out. */
  readonly hint?: ReactNode;
  /** Under the list: how a private channel gets here. */
  readonly privateHint: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(CHANNEL_PAGE);
  const needle = query.trim().replace(/^#/, "").toLowerCase();
  const matches = groups.flatMap((group) =>
    group.options.filter((option) =>
      option.name.replace(/^#/, "").toLowerCase().includes(needle),
    ),
  );
  // Stand-in: the kit's option has no trailing slot, so the tag takes the
  // second line (PartRequest "Combobox option tag").
  const options: ComboboxOption[] = matches.slice(0, shown).map((option) => ({
    value: option.name,
    label: option.name,
    description: (
      <Badge variant="gray">
        {option.private
          ? option.disabled
            ? "비공개 · 승인 대기"
            : "비공개"
          : "공개"}
      </Badge>
    ),
    disabled: option.disabled ?? false,
  }));
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      <Combobox
        options={options}
        value={value || null}
        onValueChange={(next) => onChange(next)}
        filter="none"
        onQueryChange={(next) => {
          setQuery(next);
          setShown(CHANNEL_PAGE);
        }}
        hasMore={matches.length > shown}
        onLoadMore={() => setShown((current) => current + CHANNEL_PAGE)}
        loadMoreLabel={`더 보기 (${matches.length - shown}개 남음)`}
        emptyMessage="맞는 채널이 없습니다."
        resultCountMessage={(count) => `채널 ${count}개`}
        placeholder="채널 이름으로 검색"
      />
      <FieldDescription>{privateHint}</FieldDescription>
      <PartRequest name="Combobox option tag" />
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
  "봇이 인사하고 멘션에 답하는 채널입니다. 공개 채널은 고르면 봇이 참여해 인사를 1건 보냅니다.";

/** Where a private channel comes from, under a home channel list. */
export function homePrivateHint(bot: string): string {
  return `비공개 채널은 Slack에서 /invite ${bot} 후 여기에 나타납니다. 승인한 뒤에 고를 수 있습니다.`;
}

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
          hint={HOME_CHANNEL_HINT}
          privateHint={homePrivateHint(bot)}
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
