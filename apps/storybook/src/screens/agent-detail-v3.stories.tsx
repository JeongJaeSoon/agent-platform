import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  DestructiveActionDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Link,
  NativeSelect,
  NativeSelectOption,
  PageHeader,
  RowList,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useDetailLayout,
} from "@werft-ai/ui";
import { ArrowLeft, Copy, LoaderCircle, Plus } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { MOBILE, PartRequest, ScreenShell } from "./screen-kit.tsx";
import {
  AlertCard,
  type ChannelGroup,
  ChannelSelect,
  type ConnectStep,
  Heading,
  MUTED_TEXT,
  OutcomeStandIn,
  SettingRow,
  SlackConnectCard,
  SwitchStandIn,
  storyHref,
} from "./slack-kit.tsx";

/*
 * Agent detail with the Slack tab of the v3 mockup
 * (slack-console-mockup-v3.html, v3-ia.md §3.2–3.4), on apps/web
 * agent-detail.tsx as main draws it. The other four tabs keep only their
 * head. The Slack tab walks: switches, dialogs and the review's three
 * buttons all reach their result lines.
 */

const AGENT = {
  name: "Release Notes",
  slug: "release-notes",
  active: "version 1 · claude-coding-local",
  latest: "version 1 · 2026. 10. 23. 21:48",
  role: "배포가 끝나면 릴리즈 노트 초안을 씁니다",
  model: "claude-sonnet-5",
};
const BOT = "@release-notes";
const HOME = "#release-notes";
const INVITE = `/invite ${BOT}`;
const REQUEST = {
  channel: "#finance-private",
  by: "kim.dev",
  at: "2026. 10. 23. 15:02",
};
const PUBLIC_JOINED = [HOME, "#dev-platform"];
const PUBLIC_UNJOINED = ["#general", "#random"];
const APP_ID = "A07PLACEHLD";
const EVENT_URL =
  "https://agents.verify.example/v1/slack/events/ebc9271d-5cec-4c73-bd7d-7efbda71d2a9";
const REACTIONS = ["멘션할 때", "모든 메시지", "꺼짐"];
const VISIBILITY =
  "승인하면 이 채널에서 시작한 세션이 웹 콘솔에 남습니다. 세션은 공유 범위를 바꾸지 않으면 워크스페이스 구성원 모두가 읽을 수 있습니다.";

const STORY = "screens-agent-detail-v3--agent-detail";

type SlackState =
  | "connected"
  | "todo"
  | "error"
  | "nohome"
  | "installed"
  | "none";
type Segment = "overview" | "channels" | "defaults" | "advanced";
type DialogKind = "review" | "add" | "home" | "disconnect" | "delete";
type RequestState = "pending" | "approved" | "rejected";

const STATUS = {
  connected: ["연결됨", "green"],
  todo: ["조치 필요", "amber"],
  nohome: ["조치 필요", "amber"],
  error: ["오류", "red"],
} as const;

const SEGMENTS: readonly (readonly [Segment, string])[] = [
  ["overview", "개요"],
  ["channels", "채널"],
  ["defaults", "기본 설정"],
  ["advanced", "고급"],
];

const PANEL_CARD = "min-w-0 gap-3 p-4";
const FACTS =
  "m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-control";
const OVERVIEW_FACTS =
  "m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-control sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-y-3";
const TERM = "m-0 text-muted-foreground";
const VALUE = "m-0 font-medium [overflow-wrap:anywhere]";
const SECTION = "flex flex-col gap-[var(--ap-space-block)]";
const SECONDARY = "text-caption text-muted-foreground";

function Section({
  title,
  hint,
  action,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={SECTION}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading id={titleId}>{title}</Heading>
        {action}
      </div>
      {hint ? <div className={MUTED_TEXT}>{hint}</div> : null}
      {children}
    </section>
  );
}

function SummaryPanel() {
  return (
    <aside aria-label="에이전트 요약" className="flex min-w-0 flex-col gap-4">
      <Card className={PANEL_CARD}>
        <CardTitle role="heading" aria-level={2}>
          요약
        </CardTitle>
        <dl className={FACTS}>
          <dt className={TERM}>식별자</dt>
          <dd className={`${VALUE} font-mono text-caption`}>{AGENT.slug}</dd>
          <dt className={TERM}>활성 release</dt>
          <dd className={VALUE}>{AGENT.active}</dd>
          <dt className={TERM}>최신 version</dt>
          <dd className={VALUE}>{AGENT.latest}</dd>
        </dl>
        <div className={MUTED_TEXT}>새 세션은 최신 version으로 시작합니다.</div>
      </Card>
    </aside>
  );
}

function CardSummary() {
  return (
    <Card className={PANEL_CARD}>
      <CardTitle role="heading" aria-level={2}>
        개요
      </CardTitle>
      <dl className={OVERVIEW_FACTS}>
        <dt className={TERM}>역할</dt>
        <dd className={VALUE}>{AGENT.role}</dd>
        <dt className={TERM}>모델</dt>
        <dd className={`${VALUE} font-mono text-caption`}>{AGENT.model}</dd>
        <dt className={TERM}>언어</dt>
        <dd className={VALUE}>한국어</dd>
        <dt className={TERM}>도구</dt>
        <dd className={VALUE}>모든 도구</dd>
        <dt className={TERM}>금지</dt>
        <dd className={VALUE}>없음</dd>
      </dl>
    </Card>
  );
}

function Parts({ names }: { readonly names: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((name) => (
        <PartRequest key={name} name={name} />
      ))}
    </div>
  );
}

function CopyButton({ text }: { readonly text: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`${text} 복사`}
      onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}
    >
      <Copy aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
      복사
    </Button>
  );
}

function ReactionSelect({
  channel,
  value,
  onChange,
}: {
  readonly channel: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <>
      <div aria-hidden="true" className={SECONDARY}>
        반응
      </div>
      <NativeSelect
        size="sm"
        aria-label={`${channel} 반응`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {REACTIONS.map((reaction) => (
          <NativeSelectOption key={reaction} value={reaction}>
            {reaction}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </>
  );
}

function ChannelLines({
  name,
  sub,
  badge,
}: {
  readonly name: string;
  readonly sub: string;
  readonly badge?: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        {name}
        {badge}
      </div>
      <div className={SECONDARY}>{sub}</div>
    </>
  );
}

/** Stand-in for the review dialog: cancel, reject (reason required), approve. */
function ReviewDialog({
  open,
  onClose,
  onReject,
  onApprove,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onReject: (reason: string) => void;
  readonly onApprove: () => void;
}) {
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{REQUEST.channel} 연결 요청</DialogTitle>
          <DialogDescription>
            {REQUEST.by}가 {REQUEST.at}에 {BOT}를 이 비공개 채널에 초대했습니다.
            승인하기 전에는 이 채널의 메시지를 받지 않습니다.
          </DialogDescription>
        </DialogHeader>
        <PartRequest name="Review dialog" />
        <Card
          role="note"
          className="border-(color:--ap-tone-attention-border) p-3 text-control"
        >
          {VISIBILITY}
        </Card>
        <Field>
          <FieldLabel>사유</FieldLabel>
          <Textarea
            ref={reasonRef}
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (event.target.value.trim()) setMissing(false);
            }}
          />
          <FieldDescription>
            거절할 때는 꼭 적습니다. 승인할 때는 적지 않아도 됩니다. 감사 기록에
            남습니다.
          </FieldDescription>
          {missing ? (
            <FieldError>거절하려면 사유를 적어 주세요.</FieldError>
          ) : null}
        </Field>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              취소
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (!reason.trim()) {
                setMissing(true);
                reasonRef.current?.focus();
                return;
              }
              onReject(reason.trim());
            }}
          >
            거절
          </Button>
          <Button type="button" onClick={onApprove}>
            승인
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CallbackPage({ state }: { readonly state: "working" | "denied" }) {
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col">
      <PageHeader title="Slack 설치" />
      {state === "working" ? (
        <output
          aria-busy="true"
          className="flex items-center gap-2 text-control"
        >
          <LoaderCircle
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
            strokeWidth={1.5}
          />
          Slack 설치를 마무리하는 중…
        </output>
      ) : (
        <div className={SECTION}>
          <OutcomeStandIn tone="danger">
            Slack에서 설치를 허용하지 않았습니다. 앱은 만들었지만 설치되지
            않았습니다. 허용하려면 Slack 탭에서 다시 연결하세요.
          </OutcomeStandIn>
          <Link href={storyHref(`${STORY}-slack-none`)} underline="always">
            Slack 탭으로
          </Link>
        </div>
      )}
    </div>
  );
}

interface ScreenProps {
  readonly tab: "overview" | "slack";
  readonly slack: SlackState;
  readonly segment: Segment;
  readonly dialog?: DialogKind | undefined;
  readonly callback?: "working" | "denied" | undefined;
  readonly slackOn?: boolean | undefined;
}

function AgentDetailScreen(props: ScreenProps) {
  const [tab, setTab] = useState(props.tab);
  const [slack, setSlack] = useState(props.slack);
  const [segment, setSegment] = useState(props.segment);
  const [dialog, setDialog] = useState(props.dialog);
  const [callback, setCallback] = useState(props.callback);
  const [walking, setWalking] = useState(false);
  const [on, setOn] = useState(props.slackOn ?? true);
  const [dm, setDm] = useState(true);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [request, setRequest] = useState<RequestState>(
    props.slack === "todo" ? "pending" : "approved",
  );
  const [home, setHome] = useState(props.slack === "nohome" ? "" : HOME);
  const [added, setAdded] = useState<readonly string[]>([]);
  const [reactions, setReactions] = useState<Record<string, string>>({
    "#dev-platform": "꺼짐",
  });
  const [defaultReaction, setDefaultReaction] = useState(REACTIONS[0] ?? "");
  const [expanded, setExpanded] = useState(false);
  const [homePick, setHomePick] = useState("");
  const [addPick, setAddPick] = useState("");
  const layout = useDetailLayout();

  // The install callback finishes on its own and replaces itself with the tab.
  useEffect(() => {
    if (callback !== "working" || !walking) return;
    const timer = setTimeout(() => {
      setCallback(undefined);
      setSlack("installed");
    }, 1500);
    return () => clearTimeout(timer);
  }, [callback, walking]);

  if (callback) {
    return (
      <ScreenShell current="agents" crumb={["에이전트"]}>
        <CallbackPage state={callback} />
      </ScreenShell>
    );
  }

  const pending = request === "pending" && slack === "todo";
  const joined = [
    ...new Set([home, ...PUBLIC_JOINED, ...added].filter(Boolean)),
  ];
  const status =
    slack === "installed" || slack === "none" ? undefined : STATUS[slack];
  const show = (text: string, next?: Segment) => {
    setOutcome(text);
    if (next) setSegment(next);
  };
  const reactionOf = (channel: string) => reactions[channel] ?? defaultReaction;
  const changeReaction = (channel: string, value: string) => {
    setReactions((current) => ({ ...current, [channel]: value }));
    show(`${channel} 반응을 '${value}'(으)로 바꿨습니다. 바로 저장됐습니다.`);
  };
  const openDialog = (kind: DialogKind) => {
    setHomePick("");
    setAddPick("");
    setDialog(kind);
  };

  const homeGroups: readonly ChannelGroup[] = [
    {
      label: "공개 채널",
      options: [
        ...joined.map((name) => ({
          name,
          note: name === home ? "현재 홈 채널" : "공개 · 연결됨",
        })),
        ...PUBLIC_UNJOINED.filter((name) => !joined.includes(name)).map(
          (name) => ({ name, note: "공개 · 고르면 봇이 참여" }),
        ),
      ],
    },
    {
      label: "비공개 채널",
      options:
        request === "approved"
          ? [{ name: REQUEST.channel, note: "비공개 · 승인됨" }]
          : request === "pending"
            ? [
                {
                  name: REQUEST.channel,
                  note: "비공개 · 승인 대기, 승인한 뒤 고를 수 있음",
                  disabled: true,
                },
              ]
            : [],
    },
  ];
  const addGroups: readonly ChannelGroup[] = [
    {
      label: "공개 채널",
      options: PUBLIC_UNJOINED.filter((name) => !joined.includes(name)).map(
        (name) => ({ name, note: "공개 · 고르면 봇이 참여" }),
      ),
    },
  ];

  const todo: (readonly [string, ReactNode])[] = [];
  if (pending) {
    todo.push([
      `비공개 채널 ${REQUEST.channel} 승인 요청 1건`,
      <Button
        key="review"
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setOutcome(null);
          setSegment("channels");
          openDialog("review");
        }}
      >
        검토
      </Button>,
    ]);
  }
  if (slack === "error") {
    todo.push([
      "Slack이 이벤트 주소를 확인하지 못해 멘션을 받지 못하고 있습니다(url_verification_failed).",
      <Button
        key="register"
        type="button"
        variant="outline"
        size="sm"
        onClick={() => reregister()}
      >
        다시 등록
      </Button>,
    ]);
  }
  if (slack === "nohome") {
    todo.push([
      "홈 채널을 고르지 않았습니다. 봇은 아직 어느 채널에도 인사하지 않았습니다.",
      <Button
        key="home"
        type="button"
        variant="outline"
        size="sm"
        onClick={() => openDialog("home")}
      >
        홈 채널 선택
      </Button>,
    ]);
  }
  function reregister() {
    setSlack("connected");
    show(
      "이벤트 주소를 다시 등록했습니다. Slack이 2026. 10. 23. 22:14에 확인했습니다.",
    );
  }

  const overview = (
    <>
      <RowList variant="joined">
        <SettingRow
          title="Slack 연결"
          description={
            on
              ? "끄면 멘션과 DM을 받지 않습니다. Slack 앱과 채널 설정은 남아서 다시 켜면 그대로 이어집니다."
              : "꺼져 있습니다. 멘션과 DM을 받지 않습니다."
          }
          control={({ titleId, descriptionId }) => (
            <SwitchStandIn
              checked={on}
              labelledBy={titleId}
              describedBy={descriptionId}
              onCheckedChange={(next) => {
                setOn(next);
                show(
                  next
                    ? "Slack 연결을 켰습니다. 멘션과 DM을 다시 받습니다."
                    : "Slack 연결을 껐습니다. 멘션과 DM을 받지 않습니다.",
                );
              }}
            />
          )}
        />
      </RowList>
      {todo.length > 0 ? (
        <AlertCard
          level={2}
          tone={slack === "error" ? "danger" : "attention"}
          title={`할 일 ${todo.length}건`}
        >
          <ul className="m-0 flex w-full list-none flex-col gap-2 p-0">
            {todo.map(([text, action]) => (
              <li
                key={text}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
              >
                <div className="min-w-0 flex-1">{text}</div>
                {action}
              </li>
            ))}
          </ul>
        </AlertCard>
      ) : null}
      <RowList variant="joined">
        <SettingRow
          title="DM 받기"
          description={
            on
              ? "Slack 앱의 메시지 탭에서 1:1 대화를 받습니다. Slack 계정을 연동한 구성원만 쓸 수 있습니다."
              : "Slack 연결이 꺼져 있어 바꿀 수 없습니다."
          }
          control={({ titleId, descriptionId }) => (
            <SwitchStandIn
              checked={dm}
              disabled={!on}
              labelledBy={titleId}
              describedBy={descriptionId}
              onCheckedChange={(next) => {
                setDm(next);
                show(
                  next
                    ? "DM 받기를 켰습니다."
                    : "DM 받기를 껐습니다. 채널 멘션은 그대로 받습니다.",
                );
              }}
            />
          )}
        />
      </RowList>
      <Card className={PANEL_CARD}>
        <CardTitle role="heading" aria-level={2}>
          연결
        </CardTitle>
        <dl className={OVERVIEW_FACTS}>
          <dt className={TERM}>상태</dt>
          <dd className={VALUE}>
            <div className="flex flex-wrap items-center gap-2">
              {status ? <Badge variant={status[1]}>{status[0]}</Badge> : null}
              {on ? null : (
                <div className="font-normal text-muted-foreground">꺼짐</div>
              )}
            </div>
          </dd>
          <dt className={TERM}>봇</dt>
          <dd className={VALUE}>{BOT}</dd>
          <dt className={TERM}>홈 채널</dt>
          <dd className={VALUE}>
            {home ? (
              <div className="flex flex-wrap items-center gap-x-3">
                {home}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0"
                  onClick={() => openDialog("home")}
                >
                  바꾸기
                </Button>
              </div>
            ) : (
              <div className="font-normal text-muted-foreground">
                선택 안 됨
              </div>
            )}
          </dd>
        </dl>
      </Card>
    </>
  );

  const channels = (
    <>
      {pending ? (
        <Section
          title="승인 대기"
          hint="승인하기 전에는 이 채널의 메시지를 받지 않습니다. 이 목록은 승인할 수 있는 사람(이 에이전트의 관리자, 워크스페이스 소유자·관리자)에게만 보입니다."
        >
          <RowList variant="joined">
            <SettingRow
              title={REQUEST.channel}
              description={`비공개 · ${REQUEST.by}가 ${REQUEST.at}에 초대`}
              control={() => (
                <Button
                  type="button"
                  size="sm"
                  aria-label={`${REQUEST.channel} 검토`}
                  onClick={() => openDialog("review")}
                >
                  검토
                </Button>
              )}
            />
          </RowList>
        </Section>
      ) : null}
      <Section
        title="연결된 채널"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openDialog("add")}
          >
            <Plus aria-hidden="true" strokeWidth={1.5} />
            채널 추가
          </Button>
        }
      >
        <RowList variant="joined">
          {joined.map((name) => (
            <SettingRow
              key={name}
              title={
                <ChannelLines
                  name={name}
                  sub={name === home ? "공개 · 홈 채널" : "공개"}
                />
              }
              control={() => (
                <>
                  <ReactionSelect
                    channel={name}
                    value={reactionOf(name)}
                    onChange={(value) => changeReaction(name, value)}
                  />
                  {name === home ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`${name} 홈 지정`}
                      onClick={() => {
                        openDialog("home");
                        setHomePick(name);
                      }}
                    >
                      홈 지정
                    </Button>
                  )}
                </>
              )}
            />
          ))}
          {request === "approved" ? (
            <SettingRow
              title={
                <ChannelLines
                  name={REQUEST.channel}
                  sub={`비공개 · ${REQUEST.by} 초대 · 승인함`}
                />
              }
              control={() => (
                <ReactionSelect
                  channel={REQUEST.channel}
                  value={reactionOf(REQUEST.channel)}
                  onChange={(value) => changeReaction(REQUEST.channel, value)}
                />
              )}
            />
          ) : null}
          {slack === "error" ? (
            <SettingRow
              title={
                <ChannelLines
                  name="#launch-2025"
                  sub="공개 · 참여하지 못했습니다. 보관된 채널입니다(is_archived)"
                  badge={<Badge variant="red">오류</Badge>}
                />
              }
              control={() => (
                <Button type="button" variant="outline" size="sm">
                  다시 시도
                </Button>
              )}
            />
          ) : null}
        </RowList>
      </Section>
      <Section
        title="비공개 채널"
        hint="봇을 비공개 채널에 넣으려면 그 채널에서 아래 명령을 보내세요. 초대되면 승인 대기에 나타나고, 승인한 뒤에 메시지를 받습니다."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="font-mono font-normal">{INVITE}</Badge>
          <CopyButton text={INVITE} />
        </div>
      </Section>
    </>
  );

  const defaults = (
    <RowList variant="joined">
      <SettingRow
        title="새 채널의 기본 반응"
        description="채널을 추가하거나 승인하면 이 반응으로 시작합니다. 이미 연결된 채널에는 적용하지 않습니다. 채널마다 바꾸려면 채널 메뉴에서 바꿉니다. 바꾸면 바로 저장됩니다."
        control={({ titleId }) => (
          <NativeSelect
            size="sm"
            aria-labelledby={titleId}
            value={defaultReaction}
            onChange={(event) => {
              setDefaultReaction(event.target.value);
              show(
                `새 채널의 기본 반응을 '${event.target.value}'(으)로 바꿨습니다. 바로 저장됐고, 이미 연결된 채널은 그대로입니다.`,
              );
            }}
          >
            {REACTIONS.map((reaction) => (
              <NativeSelectOption key={reaction} value={reaction}>
                {reaction}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      />
    </RowList>
  );

  const value = (text: string, mono = true, wrap = false) => (
    <div
      className={`${mono ? "font-mono text-caption" : "text-control"} ${wrap ? "break-all" : "truncate"}`}
    >
      {text}
    </div>
  );
  const advanced = (
    <>
      <RowList variant="joined">
        <SettingRow
          title="앱 ID"
          extra={value(APP_ID)}
          control={() => (
            <>
              <CopyButton text={APP_ID} />
              <Button asChild variant="outline" size="sm">
                <a href="#slack-app">Slack에서 열기</a>
              </Button>
            </>
          )}
        />
        <SettingRow
          title={
            <div className="flex flex-wrap items-center gap-2">
              이벤트 주소
              {slack === "error" ? <Badge variant="red">오류</Badge> : null}
            </div>
          }
          extra={
            <>
              {value(EVENT_URL, true, expanded)}
              <div className={SECONDARY}>
                {slack === "error"
                  ? "2026. 10. 23. 22:10 Slack이 확인하지 못함"
                  : "2026. 10. 23. 21:50 Slack이 확인함"}
              </div>
            </>
          }
          control={() => (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "접기" : "펼치기"}
              </Button>
              <CopyButton text={EVENT_URL} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => reregister()}
              >
                다시 등록
              </Button>
            </>
          )}
        />
        <SettingRow
          title="환영 기록"
          extra={value(
            `${home || HOME} · 2026. 10. 23. 21:52 · rel_3f9a`,
            false,
          )}
        />
      </RowList>
      <Section title="위험 작업">
        <RowList
          variant="joined"
          className="border-(color:--ap-tone-danger-border)"
        >
          <SettingRow
            title="Slack 연결 해제"
            description="봇 token을 회수합니다. Slack 앱은 남아 다시 설치할 수 있습니다."
            control={() => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openDialog("disconnect")}
              >
                연결 해제
              </Button>
            )}
          />
          <SettingRow
            title="Slack 앱 삭제"
            description="Slack에서 앱을 지웁니다. 되돌릴 수 없고, 다시 연결하면 새 앱이 생깁니다."
            control={() => (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => openDialog("delete")}
              >
                앱 삭제
              </Button>
            )}
          />
        </RowList>
      </Section>
    </>
  );

  const SEGMENT_BODY = { overview, channels, defaults, advanced };
  const SEGMENT_PARTS = {
    overview: ["Switch", "SettingRow", "Combobox"],
    channels: ["SettingRow", "Combobox", "Review dialog"],
    defaults: ["SettingRow"],
    advanced: ["SettingRow"],
  } satisfies Record<Segment, readonly string[]>;

  const connectStep: ConnectStep | null =
    slack === "none" ? "allow" : slack === "installed" ? "pick" : null;
  const slackPanel = connectStep ? (
    <>
      {connectStep === "pick" ? <Parts names={["Combobox"]} /> : null}
      <SlackConnectCard
        key={connectStep}
        step={connectStep}
        wizard={false}
        bot={BOT}
        description={AGENT.role}
        channels={homeGroups}
        home={home || HOME}
        onStep={(next, picked) => {
          if (next === "allowed") {
            setWalking(true);
            setCallback("working");
          } else if (next === "done" && picked) {
            setHome(picked);
            setSlack("connected");
            setSegment("overview");
            show(
              `연결됨 · ${BOT} · ${picked}. ${picked}에 인사를 1건 보냈습니다.`,
            );
          } else if (next === "later") {
            setHome("");
            setSlack("nohome");
            setSegment("overview");
            setOutcome(null);
          }
        }}
      />
    </>
  ) : (
    <Tabs
      value={segment}
      onValueChange={(next) => {
        setSegment(next as Segment);
        setOutcome(null);
      }}
      className="min-w-0 gap-[var(--ap-space-block)]"
    >
      <TabsList aria-label="Slack 메뉴">
        {SEGMENTS.map(([key, label]) => (
          <TabsTrigger key={key} value={key}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {SEGMENTS.map(([key]) => (
        <TabsContent
          key={key}
          value={key}
          className="flex flex-col gap-[var(--ap-space-block)]"
        >
          <Parts names={SEGMENT_PARTS[key]} />
          {outcome ? (
            <OutcomeStandIn key={outcome}>{outcome}</OutcomeStandIn>
          ) : null}
          {SEGMENT_BODY[key]}
        </TabsContent>
      ))}
    </Tabs>
  );

  const tabs = (
    <Tabs
      value={tab}
      onValueChange={(next) => setTab(next as typeof tab)}
      className="min-w-0 gap-[var(--ap-space-block)]"
    >
      <div className="border-b">
        <TabsList variant="line" aria-label="에이전트 상세" className="h-9 p-0">
          {(["overview", "card", "release", "admins"] as const).map((key) => (
            <TabsTrigger
              key={key}
              value={key}
              className="h-9 text-control after:bottom-0"
            >
              {
                {
                  overview: "개요",
                  card: "카드",
                  release: "배포",
                  admins: "관리자",
                }[key]
              }
            </TabsTrigger>
          ))}
          <TabsTrigger
            value="slack"
            className="h-9 text-control after:bottom-0"
          >
            Slack
            {status && status[0] !== "연결됨" ? (
              <Badge variant={status[1]}>{status[0]}</Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="overview" className="flex flex-col gap-8 pt-4">
        <CardSummary />
      </TabsContent>
      {(["card", "release", "admins"] as const).map((key) => (
        <TabsContent key={key} value={key} className="flex flex-col gap-8 pt-4">
          <div className={MUTED_TEXT}>
            이 탭은 이 story에서 머리만 둡니다. 내용은 실제 화면 그대로입니다.
          </div>
        </TabsContent>
      ))}
      <TabsContent
        value="slack"
        className="flex flex-col gap-[var(--ap-space-block)] pt-4"
      >
        {slackPanel}
      </TabsContent>
    </Tabs>
  );

  const panel = <SummaryPanel key="panel" />;
  const body = <div key="body">{tabs}</div>;

  return (
    <ScreenShell current="agents" crumb={["에이전트"]}>
      <PageHeader
        title={AGENT.name}
        description={<Badge variant="green">활성</Badge>}
        actions={
          <Button asChild variant="outline" size="sm">
            <a href="#agents">
              <ArrowLeft aria-hidden="true" className="size-3.5" />
              에이전트 목록
            </a>
          </Button>
        }
      />
      <div ref={layout.ref} className={layout.className}>
        {layout.narrow ? [panel, body] : [body, panel]}
      </div>
      <ReviewDialog
        open={dialog === "review"}
        onClose={() => setDialog(undefined)}
        onReject={(reason) => {
          setRequest("rejected");
          setSlack("connected");
          setDialog(undefined);
          show(
            `거절함 · ${REQUEST.channel} · 봇이 채널에서 나감. 채널에는 아무것도 보내지 않았습니다. 사유: ${reason}`,
            "channels",
          );
        }}
        onApprove={() => {
          setRequest("approved");
          setSlack("connected");
          setDialog(undefined);
          show(
            `승인함 · ${REQUEST.channel} · 알림 보냄. 봇이 "이 채널에 추가됐습니다"를 1건 보냈습니다.`,
            "channels",
          );
        }}
      />
      <ConfirmDialog
        open={dialog === "home"}
        onOpenChange={(open) => (open ? undefined : setDialog(undefined))}
        title="홈 채널"
        consequence="봇이 인사하고 멘션에 답하는 채널입니다. 공개 채널로 바꾸면 봇이 참여해 인사를 1건 보냅니다."
        confirmLabel="홈 채널로 정하기"
        confirmDisabled={!homePick}
        onConfirm={() => {
          const same = homePick === home;
          setHome(homePick);
          if (slack === "nohome") setSlack("connected");
          setDialog(undefined);
          show(
            same
              ? `홈 채널은 그대로 ${homePick}입니다.`
              : `홈 채널을 ${homePick}(으)로 정했습니다. ${homePick}에 인사를 1건 보냈습니다.`,
          );
        }}
      >
        <ChannelSelect
          label="홈 채널"
          groups={homeGroups}
          value={homePick}
          onChange={setHomePick}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "add"}
        onOpenChange={(open) => (open ? undefined : setDialog(undefined))}
        title="채널 추가"
        consequence="공개 채널은 고르면 봇이 바로 참여합니다. 홈 채널이 아니라서 인사는 보내지 않습니다."
        confirmLabel="추가"
        confirmDisabled={!addPick}
        onConfirm={() => {
          setAdded((current) => [...current, addPick]);
          setDialog(undefined);
          show(
            `추가함 · ${addPick} · 봇이 참여함. 반응은 기본값 '${defaultReaction}'. 홈 채널이 아니라 인사는 보내지 않았습니다.`,
            "channels",
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <ChannelSelect
            label="채널"
            groups={addGroups}
            value={addPick}
            onChange={setAddPick}
          />
          <div className={MUTED_TEXT}>
            비공개 채널은 목록에 없습니다. 그 채널에서 {INVITE}를 보내면 승인
            대기에 나타납니다.
          </div>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "disconnect"}
        onOpenChange={(open) => (open ? undefined : setDialog(undefined))}
        title="Slack 연결을 해제할까요?"
        consequence="봇 token을 회수합니다. 진행 중인 Slack 스레드에는 더 답하지 않습니다. Slack 앱은 남아 있어 다시 설치할 수 있습니다."
        confirmLabel="연결 해제"
        tone="danger"
        onConfirm={() => {
          setDialog(undefined);
          setSlack("none");
        }}
      />
      <DestructiveActionDialog
        open={dialog === "delete"}
        onOpenChange={(open) => (open ? undefined : setDialog(undefined))}
        title="Slack 앱을 삭제할까요?"
        consequence="Slack 워크스페이스에서 앱과 봇 사용자가 사라집니다. 되돌릴 수 없습니다. 에이전트와 세션 기록은 남습니다."
        resourceName={AGENT.slug}
        confirmLabel="앱 삭제"
        onConfirm={() => {
          setDialog(undefined);
          setSlack("none");
        }}
      />
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Agent detail (v3)",
  component: AgentDetailScreen,
  parameters: { layout: "fullscreen" },
  args: { tab: "slack", slack: "connected", segment: "overview" },
} satisfies Meta<typeof AgentDetailScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const DARK = { theme: "dark" };

export const AgentDetailOverviewTab: Story = {
  name: "개요 탭 (Slack 정상)",
  args: { tab: "overview" },
};
export const AgentDetailOverviewTabDark: Story = {
  ...AgentDetailOverviewTab,
  name: "개요 탭 (dark)",
  globals: DARK,
};
export const AgentDetailOverviewTabMobile: Story = {
  ...AgentDetailOverviewTab,
  name: "개요 탭 (390px)",
  globals: MOBILE,
};

export const AgentDetailSlackOverview: Story = { name: "Slack › 개요: 정상" };
export const AgentDetailSlackOverviewDark: Story = {
  name: "Slack › 개요: 정상 (dark)",
  globals: DARK,
};
export const AgentDetailSlackOverviewMobile: Story = {
  name: "Slack › 개요: 정상 (390px)",
  globals: MOBILE,
};

export const AgentDetailSlackOff: Story = {
  name: "Slack › 개요: 꺼짐",
  args: { slackOn: false },
};
export const AgentDetailSlackOffDark: Story = {
  ...AgentDetailSlackOff,
  name: "Slack › 개요: 꺼짐 (dark)",
  globals: DARK,
};
export const AgentDetailSlackOffMobile: Story = {
  ...AgentDetailSlackOff,
  name: "Slack › 개요: 꺼짐 (390px)",
  globals: MOBILE,
};

export const AgentDetailSlackTodo: Story = {
  name: "Slack › 개요: 승인 대기",
  args: { slack: "todo" },
};
export const AgentDetailSlackTodoDark: Story = {
  ...AgentDetailSlackTodo,
  name: "Slack › 개요: 승인 대기 (dark)",
  globals: DARK,
};
export const AgentDetailSlackTodoMobile: Story = {
  ...AgentDetailSlackTodo,
  name: "Slack › 개요: 승인 대기 (390px)",
  globals: MOBILE,
};

export const AgentDetailSlackError: Story = {
  name: "Slack › 개요: 오류",
  args: { slack: "error" },
};
export const AgentDetailSlackErrorDark: Story = {
  ...AgentDetailSlackError,
  name: "Slack › 개요: 오류 (dark)",
  globals: DARK,
};
export const AgentDetailSlackErrorMobile: Story = {
  ...AgentDetailSlackError,
  name: "Slack › 개요: 오류 (390px)",
  globals: MOBILE,
};

export const AgentDetailSlackNoHome: Story = {
  name: "Slack › 개요: 홈 채널 미선택",
  args: { slack: "nohome" },
};
export const AgentDetailSlackNoHomeDark: Story = {
  ...AgentDetailSlackNoHome,
  name: "Slack › 개요: 홈 채널 미선택 (dark)",
  globals: DARK,
};
export const AgentDetailSlackNoHomeMobile: Story = {
  ...AgentDetailSlackNoHome,
  name: "Slack › 개요: 홈 채널 미선택 (390px)",
  globals: MOBILE,
};

export const AgentDetailSlackChannels: Story = {
  name: "Slack › 채널: 승인 대기",
  args: { slack: "todo", segment: "channels" },
};
export const AgentDetailSlackChannelsDark: Story = {
  ...AgentDetailSlackChannels,
  name: "Slack › 채널 (dark)",
  globals: DARK,
};
export const AgentDetailSlackChannelsMobile: Story = {
  ...AgentDetailSlackChannels,
  name: "Slack › 채널 (390px)",
  globals: MOBILE,
};

export const AgentDetailSlackDefaults: Story = {
  name: "Slack › 기본 설정",
  args: { segment: "defaults" },
};
export const AgentDetailSlackDefaultsDark: Story = {
  ...AgentDetailSlackDefaults,
  name: "Slack › 기본 설정 (dark)",
  globals: DARK,
};
export const AgentDetailSlackDefaultsMobile: Story = {
  ...AgentDetailSlackDefaults,
  name: "Slack › 기본 설정 (390px)",
  globals: MOBILE,
};

export const AgentDetailSlackAdvanced: Story = {
  name: "Slack › 고급",
  args: { segment: "advanced" },
};
export const AgentDetailSlackAdvancedDark: Story = {
  ...AgentDetailSlackAdvanced,
  name: "Slack › 고급 (dark)",
  globals: DARK,
};
export const AgentDetailSlackAdvancedMobile: Story = {
  ...AgentDetailSlackAdvanced,
  name: "Slack › 고급 (390px)",
  globals: MOBILE,
};

export const AgentDetailSlackAdvancedError: Story = {
  name: "Slack › 고급: 오류 (고치기)",
  args: { slack: "error", segment: "advanced" },
};

export const AgentDetailSlackNone: Story = {
  name: "Slack: 연결 안 됨",
  args: { slack: "none" },
};
export const AgentDetailSlackNoneDark: Story = {
  ...AgentDetailSlackNone,
  name: "Slack: 연결 안 됨 (dark)",
  globals: DARK,
};
export const AgentDetailSlackNoneMobile: Story = {
  ...AgentDetailSlackNone,
  name: "Slack: 연결 안 됨 (390px)",
  globals: MOBILE,
};

export const AgentDetailSlackInstalled: Story = {
  name: "Slack: 설치 직후 (홈 채널 고르기)",
  args: { slack: "installed" },
};
export const AgentDetailSlackInstalledDark: Story = {
  ...AgentDetailSlackInstalled,
  name: "Slack: 설치 직후 (dark)",
  globals: DARK,
};
export const AgentDetailSlackInstalledMobile: Story = {
  ...AgentDetailSlackInstalled,
  name: "Slack: 설치 직후 (390px)",
  globals: MOBILE,
};

export const AgentDetailCallbackWorking: Story = {
  name: "설치 콜백: 처리 중",
  args: { callback: "working" },
};
export const AgentDetailCallbackWorkingDark: Story = {
  ...AgentDetailCallbackWorking,
  name: "설치 콜백: 처리 중 (dark)",
  globals: DARK,
};
export const AgentDetailCallbackWorkingMobile: Story = {
  ...AgentDetailCallbackWorking,
  name: "설치 콜백: 처리 중 (390px)",
  globals: MOBILE,
};

export const AgentDetailCallbackDenied: Story = {
  name: "설치 콜백: 거절",
  args: { callback: "denied" },
};
export const AgentDetailCallbackDeniedDark: Story = {
  ...AgentDetailCallbackDenied,
  name: "설치 콜백: 거절 (dark)",
  globals: DARK,
};
export const AgentDetailCallbackDeniedMobile: Story = {
  ...AgentDetailCallbackDenied,
  name: "설치 콜백: 거절 (390px)",
  globals: MOBILE,
};

export const AgentDetailDialogReview: Story = {
  name: "대화상자: 승인 검토",
  args: { slack: "todo", segment: "channels", dialog: "review" },
};
export const AgentDetailDialogReviewDark: Story = {
  ...AgentDetailDialogReview,
  name: "대화상자: 승인 검토 (dark)",
  globals: DARK,
};
export const AgentDetailDialogReviewMobile: Story = {
  ...AgentDetailDialogReview,
  name: "대화상자: 승인 검토 (390px)",
  globals: MOBILE,
};

export const AgentDetailDialogAdd: Story = {
  name: "대화상자: 채널 추가",
  args: { segment: "channels", dialog: "add" },
};
export const AgentDetailDialogAddDark: Story = {
  ...AgentDetailDialogAdd,
  name: "대화상자: 채널 추가 (dark)",
  globals: DARK,
};
export const AgentDetailDialogAddMobile: Story = {
  ...AgentDetailDialogAdd,
  name: "대화상자: 채널 추가 (390px)",
  globals: MOBILE,
};

export const AgentDetailDialogHome: Story = {
  name: "대화상자: 홈 채널 선택",
  args: { dialog: "home" },
};
export const AgentDetailDialogHomeDark: Story = {
  ...AgentDetailDialogHome,
  name: "대화상자: 홈 채널 선택 (dark)",
  globals: DARK,
};
export const AgentDetailDialogHomeMobile: Story = {
  ...AgentDetailDialogHome,
  name: "대화상자: 홈 채널 선택 (390px)",
  globals: MOBILE,
};

export const AgentDetailDialogDelete: Story = {
  name: "대화상자: 앱 삭제 확인",
  args: { segment: "advanced", dialog: "delete" },
};
export const AgentDetailDialogDeleteDark: Story = {
  ...AgentDetailDialogDelete,
  name: "대화상자: 앱 삭제 확인 (dark)",
  globals: DARK,
};
export const AgentDetailDialogDeleteMobile: Story = {
  ...AgentDetailDialogDelete,
  name: "대화상자: 앱 삭제 확인 (390px)",
  globals: MOBILE,
};
