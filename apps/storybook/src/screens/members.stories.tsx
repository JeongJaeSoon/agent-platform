import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
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
  DialogTrigger,
  EmptyState,
  ErrorState,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  Input,
  Link,
  LinkTab,
  LinkTabs,
  PageHeader,
  RadioGroup,
  RadioGroupItem,
  RowLines,
  RowList,
  RowListItem,
  Section,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { fn } from "storybook/test";

import {
  LockedButton,
  MOBILE,
  PartRequest,
  ScreenShell,
} from "./screen-kit.tsx";

/*
 * v3 members screen: 구성원·팀·초대 as tabs of one page (M-01), rows that
 * only disable (M-02), team detail inside the 팀 tab (M-03). Rules in
 * .design/v3-members/plan.md §9.
 */

type Role = "owner" | "admin" | "member";
type Tab = "members" | "teams" | "invites";

const ROLE_LABEL: Record<Role, string> = {
  owner: "소유자",
  admin: "관리자",
  member: "구성원",
};

interface Member {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly active: boolean;
  readonly joined: string;
}

const MEMBERS: readonly Member[] = [
  {
    id: "u1",
    name: "Verify Owner",
    email: "owner@example.test",
    role: "owner",
    active: true,
    joined: "2026. 10. 02.",
  },
  {
    id: "u2",
    name: "Verify Dana",
    email: "dana@example.test",
    role: "admin",
    active: true,
    joined: "2026. 10. 05.",
  },
  {
    id: "u3",
    name: "Verify Minji",
    email: "minji@example.test",
    role: "member",
    active: true,
    joined: "2026. 10. 12.",
  },
  {
    id: "u4",
    name: "Verify Hoon",
    email: "hoon@example.test",
    role: "member",
    active: true,
    joined: "2026. 10. 15.",
  },
  {
    id: "u5",
    name: "Verify Sora",
    email: "sora@example.test",
    role: "member",
    active: false,
    joined: "2026. 10. 18.",
  },
];
const ME: Record<Role, string> = { owner: "u1", admin: "u2", member: "u3" };

const TEAMS = [
  {
    id: "t1",
    name: "플랫폼팀",
    members: 2,
    agents: ["release-bot", "triage", "research"],
    created: "2026. 10. 15.",
  },
  {
    id: "t2",
    name: "리서치",
    members: 1,
    agents: ["research"],
    created: "2026. 10. 16.",
  },
  {
    id: "t3",
    name: "디자인",
    members: 0,
    agents: [],
    created: "2026. 10. 20.",
  },
] as const;

const TEAM_MEMBERS = MEMBERS.filter((member) =>
  ["u3", "u4"].includes(member.id),
);
const TEAM_AGENTS = [
  { name: "release-bot", state: ["green", "활성"], at: "2026. 10. 16." },
  { name: "triage", state: ["amber", "일시정지"], at: "2026. 10. 17." },
  { name: "research", state: ["gray", "초안"], at: "2026. 10. 20." },
] as const;

const INVITES = [
  {
    email: "new@example.test",
    role: "member",
    by: "Verify Owner",
    state: ["blue", "대기 중"],
    expires: "2026. 10. 30. 09:00",
  },
  {
    email: "soon@example.test",
    role: "admin",
    by: "Verify Dana",
    state: ["amber", "곧 만료"],
    expires: "2026. 10. 24. 09:00",
  },
] as const;

// As in apps/web members.tsx: role and actions keep one width on every row,
// and the actions track never drops below its button.
const MEMBER_COLUMNS =
  "minmax(0,1.6fr) 120px minmax(var(--ap-row-action-min-width),1fr)";
const MEMBER_NARROW_COLUMNS =
  "minmax(0,1fr) 72px var(--ap-row-action-min-width)";

function access(member: Member, viewer: Role) {
  const self = member.id === ME[viewer];
  const guarded = viewer === "admin" && member.role === "owner";
  const label = member.active ? "비활성화" : "다시 활성화";
  if (self)
    return (
      <LockedButton
        label={label}
        reason="자기 자신은 비활성화할 수 없습니다."
      />
    );
  if (guarded)
    return (
      <LockedButton
        label={label}
        reason="소유자는 소유자만 바꿀 수 있습니다."
      />
    );
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`${member.name} ${label}`}
    >
      {label}
    </Button>
  );
}

function Head({
  tab,
  action,
}: {
  readonly tab: Tab;
  readonly action?: ReactNode;
}) {
  return (
    <>
      <PageHeader
        title="구성원"
        description="워크스페이스에 들어온 사람과 팀, 보낸 초대를 관리합니다."
        actions={action}
      />
      {/* Each tab is an address (/members, /members/teams, /members/invites),
          so they are LinkTabs, not Tabs. No counts: the console does not
          fetch every list just to number its tabs. */}
      <LinkTabs aria-label="구성원 보기">
        <LinkTab href="#members" current={tab === "members"}>
          구성원
        </LinkTab>
        <LinkTab href="#teams" current={tab === "teams"}>
          팀
        </LinkTab>
        <LinkTab href="#invites" current={tab === "invites"}>
          초대
        </LinkTab>
      </LinkTabs>
    </>
  );
}

const inviteButton = (
  <Button type="button">
    <Plus aria-hidden="true" />
    구성원 초대
  </Button>
);
/* The 팀 tab's head button and the dialog it opens (v4 toolbar ②); the
   console's TeamCreateDialog. `taken` shows the server's answer for a used
   name. */
function TeamCreateAction({
  initialOpen = false,
  taken = false,
}: {
  readonly initialOpen?: boolean;
  readonly taken?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />팀 만들기
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>팀 만들기</DialogTitle>
            <DialogDescription>
              이름을 정해 팀을 만듭니다. 구성원은 만든 뒤 팀 화면에서 넣습니다.
            </DialogDescription>
          </DialogHeader>
          {taken ? (
            <Alert variant="red" role="alert">
              <AlertDescription>
                같은 이름의 팀이 이미 있습니다 — 다른 이름을 쓰세요.
              </AlertDescription>
            </Alert>
          ) : null}
          <Field>
            <FieldLabel>팀 이름</FieldLabel>
            <Input
              name="team"
              maxLength={100}
              autoComplete="off"
              defaultValue={taken ? "결제팀" : ""}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                취소
              </Button>
            </DialogClose>
            <Button type="submit">팀 만들기</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
/* The console's name row (rename): the name and its button share
   one line, and the button drops under the field only when the line is too
   narrow for both. */
function TeamNameRow({
  name = "",
  submit,
}: {
  readonly name?: string | undefined;
  readonly submit: ReactNode;
}) {
  return (
    <form
      className="flex max-w-xl flex-wrap items-end gap-2"
      onSubmit={(event) => event.preventDefault()}
    >
      <Field className="min-w-0 flex-[1_1_14rem]">
        <FieldLabel>팀 이름</FieldLabel>
        <Input name="team" maxLength={100} defaultValue={name} />
      </Field>
      {submit}
    </form>
  );
}

type ListState = "ready" | "loading" | "error";

function ListBody({
  state,
  label,
  children,
}: {
  readonly state: ListState;
  readonly label: string;
  readonly children: ReactNode;
}) {
  if (state === "loading") return <Skeleton lines={5} label={label} />;
  if (state === "error")
    return (
      <ErrorState
        title={`${label}을 불러오지 못했습니다`}
        message="서버에 연결하지 못했습니다 — 네트워크 연결을 확인하세요."
        retry={() => {}}
        retryLabel="다시 시도"
      />
    );
  return <>{children}</>;
}

function MembersTab({
  viewer = "owner",
  state = "ready",
  onEdit,
}: {
  readonly viewer?: Role;
  readonly state?: ListState;
  readonly onEdit: (member: Member) => void;
}) {
  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex items-center justify-between gap-4">
        <Input
          className="max-w-[280px]"
          placeholder="이름이나 이메일로 찾기"
          aria-label="구성원 찾기"
        />
        <span className="whitespace-nowrap text-caption text-muted-foreground">
          활성 4명 · 비활성 1명
        </span>
      </div>
      <ListBody state={state} label="구성원 목록">
        <div className="flex flex-wrap gap-2">
          <PartRequest name="Avatar (UIKIT-V4-DATA-PARTS)" />
        </div>
        {/* Console v4 .t-mem without agents managed and last active: GET
            /v1/members has neither yet (94S-816), and a column empty on
            every row is left out. */}
        <div className="-m-1 grid overflow-x-auto p-1">
          <div className="rounded-card border bg-card">
            <GridTable
              aria-label="구성원"
              columns={MEMBER_COLUMNS}
              narrowAt={640}
              narrowColumns={MEMBER_NARROW_COLUMNS}
              className="min-w-[320px]"
            >
              <GridTableHeader>
                <GridTableColumnHeader>구성원</GridTableColumnHeader>
                <GridTableColumnHeader>역할</GridTableColumnHeader>
                <GridTableColumnHeader align="end">관리</GridTableColumnHeader>
              </GridTableHeader>
              {MEMBERS.map((member) => (
                <GridTableRow key={member.id} inactive={!member.active}>
                  <GridTableCell lines={true}>
                    {/* As in apps/web: the whole row opens 구성원 편집. */}
                    <GridTableRowOpener
                      aria-label={`${member.name} 편집${member.active ? "" : " (비활성)"}`}
                      onClick={() => onEdit(member)}
                    />
                    <span className="grid max-w-full grid-cols-[minmax(0,auto)_auto] items-center gap-y-[var(--ap-row-line-gap)] font-medium text-foreground @max-md:grid-cols-[minmax(0,auto)]">
                      <span className="truncate">{member.name}</span>
                      {member.active ? null : (
                        <span className="sr-only"> (비활성)</span>
                      )}
                      {member.id === ME[viewer] ? (
                        <Badge
                          variant="gray"
                          className="ms-1.5 @max-md:col-start-1 @max-md:row-start-2 @max-md:ms-0"
                        >
                          나
                        </Badge>
                      ) : null}
                    </span>
                    <span
                      className="text-muted-foreground text-xs"
                      title={member.email}
                    >
                      {member.email}
                    </span>
                  </GridTableCell>
                  <GridTableCell>
                    <Badge variant={member.role === "member" ? "gray" : "blue"}>
                      {ROLE_LABEL[member.role]}
                    </Badge>
                  </GridTableCell>
                  <GridTableCell
                    align="end"
                    raised={true}
                    className="[&_[data-slot=button]:not([data-size^=icon])]:min-w-[var(--ap-row-action-min-width)]"
                  >
                    {access(member, viewer)}
                  </GridTableCell>
                </GridTableRow>
              ))}
            </GridTable>
          </div>
        </div>
      </ListBody>
    </div>
  );
}

function TeamsTab({
  state = "ready",
  empty = false,
}: {
  readonly state?: ListState;
  readonly empty?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 pt-4">
      <ListBody state={state} label="팀 목록">
        {empty ? (
          <EmptyState
            title="아직 팀이 없습니다"
            description="팀을 만들고 에이전트 상세에서 관리자로 지정하면 팀원 모두가 그 에이전트를 관리합니다."
          />
        ) : (
          <TableContainer label="팀">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이름</TableHead>
                  <TableHead>구성원</TableHead>
                  <TableHead>관리하는 에이전트</TableHead>
                  <TableHead>만든 날</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {TEAMS.map((team) => (
                  <TableRow key={team.id}>
                    <TableCell>
                      <Link href="#team" className="focus-visible:underline">
                        {team.name}
                      </Link>
                    </TableCell>
                    <TableCell>{team.members}명</TableCell>
                    <TableCell>
                      {team.agents.length === 0 ? (
                        <span className="text-muted-foreground">없음</span>
                      ) : (
                        <span className="flex h-5 items-center gap-1">
                          {team.agents.slice(0, 2).map((agent) => (
                            <Badge key={agent}>{agent}</Badge>
                          ))}
                          {team.agents.length > 2 ? (
                            <span className="text-caption text-muted-foreground">
                              외 {team.agents.length - 2}
                            </span>
                          ) : null}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {team.created}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </ListBody>
    </div>
  );
}

function TeamDetailView({
  emptyMembers = false,
}: {
  readonly emptyMembers?: boolean;
}) {
  const membersHeadingId = useId();
  const agentsHeadingId = useId();
  return (
    <div className="flex flex-col gap-6 pt-4">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <a href="#teams">← 팀 목록</a>
      </Button>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 font-semibold text-title">플랫폼팀</h2>
          <p className="m-0 text-muted-foreground">
            팀이 관리자로 지정된 에이전트는 팀원 모두가 관리합니다.
          </p>
        </div>
        <Button type="button">구성원 추가</Button>
      </div>
      <div className="flex flex-col gap-2">
        <PartRequest name="StatStrip" />
        <div className="grid gap-4 md:grid-cols-3">
          {[
            ["구성원", emptyMembers ? "0명" : "2명"],
            ["관리하는 에이전트", "3개"],
            ["만든 날", "2026. 10. 15."],
          ].map(([label, value]) => (
            <Card key={label}>
              <CardContent className="flex flex-col gap-1">
                <span className="text-caption text-muted-foreground">
                  {label}
                </span>
                <span className="font-semibold text-title">{value}</span>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
      <Section title="팀 설정" titleAs="h3">
        <TeamNameRow
          name="플랫폼팀"
          submit={
            <Button type="submit" variant="outline" disabled>
              이름 바꾸기
            </Button>
          }
        />
      </Section>
      <section
        aria-labelledby={membersHeadingId}
        className="flex flex-col gap-3"
      >
        <h3 id={membersHeadingId} className="m-0 font-semibold">
          구성원
        </h3>
        {emptyMembers ? (
          <EmptyState
            title="이 팀에 구성원이 없습니다"
            description="구성원을 넣으면 이 팀이 관리하는 에이전트 3개를 함께 관리합니다."
            action={<Button type="button">구성원 추가</Button>}
          />
        ) : (
          <TableContainer label="플랫폼팀 구성원" className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이름</TableHead>
                  <TableHead>추가한 날</TableHead>
                  <TableHead variant="actions">관리</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {TEAM_MEMBERS.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>
                      <RowLines>
                        <span className="font-medium">{member.name}</span>
                        <span className="text-caption text-muted-foreground">
                          {member.email}
                        </span>
                      </RowLines>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {member.joined}
                    </TableCell>
                    <TableCell variant="actions">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`${member.name} 팀에서 빼기`}
                      >
                        빼기
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        {emptyMembers ? null : (
          <MobileRows
            label="플랫폼팀 구성원"
            rows={TEAM_MEMBERS.map((member) => ({
              key: member.id,
              lines: [member.name, member.email, `${member.joined} 추가`],
            }))}
          />
        )}
      </section>
      <section
        aria-labelledby={agentsHeadingId}
        className="flex flex-col gap-3"
      >
        <h3 id={agentsHeadingId} className="m-0 font-semibold">
          관리하는 에이전트
        </h3>
        <TableContainer label="플랫폼팀이 관리하는 에이전트">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>에이전트</TableHead>
                <TableHead>상태</TableHead>
                <TableHead>관리자로 지정한 날</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TEAM_AGENTS.map((agent) => (
                <TableRow key={agent.name}>
                  <TableCell>
                    <Link href="#agent" className="focus-visible:underline">
                      {agent.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={agent.state[0]}>{agent.state[1]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {agent.at}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </section>
      <Section title="위험 구역" titleAs="h3">
        <Card className="border-[var(--ap-tone-danger-border)]">
          <CardHeader>
            <CardTitle>팀 삭제</CardTitle>
            <CardDescription>
              팀을 삭제하면 이 팀이 관리자로 있던 에이전트에서도 빠집니다.
            </CardDescription>
            <CardAction>
              <Button type="button" variant="danger">
                팀 삭제
              </Button>
            </CardAction>
          </CardHeader>
        </Card>
      </Section>
    </div>
  );
}

function InvitesTab({ empty = false }: { readonly empty?: boolean }) {
  return (
    <div className="flex flex-col gap-4 pt-4">
      {empty ? (
        <EmptyState
          title="대기 중인 초대가 없습니다"
          description="초대 링크를 만들어 보내면 수락하기 전까지 여기에 남습니다."
          action={inviteButton}
        />
      ) : (
        <TableContainer label="초대" className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>이메일</TableHead>
                <TableHead>역할</TableHead>
                <TableHead>상태</TableHead>
                <TableHead>만료</TableHead>
                <TableHead variant="actions">관리</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {INVITES.map((invite) => (
                <TableRow key={invite.email}>
                  <TableCell>
                    <RowLines>
                      <span>{invite.email}</span>
                      <span className="text-caption text-muted-foreground">
                        보낸 사람: {invite.by}
                      </span>
                    </RowLines>
                  </TableCell>
                  <TableCell>{ROLE_LABEL[invite.role]}</TableCell>
                  <TableCell>
                    <Badge variant={invite.state[0]}>{invite.state[1]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {invite.expires}
                  </TableCell>
                  <TableCell variant="actions">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`${invite.email} 초대 회수`}
                    >
                      회수
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {empty ? null : (
        <MobileRows
          label="초대"
          rows={INVITES.map((invite) => ({
            key: invite.email,
            lines: [
              invite.email,
              `${ROLE_LABEL[invite.role]} · ${invite.state[1]}`,
              `만료 ${invite.expires}`,
            ],
          }))}
        />
      )}
    </div>
  );
}

/** Below md a table becomes rows with one ⋯ menu each (C-10). */
function MobileRows({
  label,
  rows,
}: {
  readonly label: string;
  readonly rows: readonly {
    readonly key: string;
    readonly lines: readonly [string, ...string[]];
  }[];
}) {
  return (
    <div className="flex flex-col gap-2 md:hidden">
      <PartRequest name="DropdownMenu" />
      <RowList aria-label={label}>
        {rows.map(({ key, lines: [first, ...rest] }) => (
          <RowListItem
            key={key}
            className="flex items-center justify-between gap-2"
          >
            <RowLines>
              <span className="font-medium">{first}</span>
              {rest.map((line) => (
                <span key={line} className="text-caption text-muted-foreground">
                  {line}
                </span>
              ))}
            </RowLines>
            <Button
              type="button"
              variant="ghost"
              className="size-11"
              aria-label={`${first} 동작`}
            >
              ⋯
            </Button>
          </RowListItem>
        ))}
      </RowList>
    </div>
  );
}

/** 구성원 편집: where the role changes now that rows only disable (M-02). */
function MemberEditDialog({
  member,
  viewer,
  onClose,
}: {
  readonly member: Member;
  readonly viewer: Role;
  readonly onClose: () => void;
}) {
  // The API refuses an admin's change to an owner (OWNER_PROTECTED).
  const ownerGuarded = viewer === "admin" && member.role === "owner";
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>구성원 편집</DialogTitle>
          <DialogDescription>
            {member.name} · {member.email}
          </DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend variant="label">역할</FieldLegend>
          {ownerGuarded ? (
            <FieldDescription>
              소유자의 역할은 소유자만 바꿀 수 있습니다.
            </FieldDescription>
          ) : null}
          <RadioGroup
            name="role"
            defaultValue={member.role}
            disabled={ownerGuarded}
            aria-label="역할"
          >
            {(
              [
                [
                  "owner",
                  "소유자",
                  "워크스페이스 설정과 소유자까지 모두 바꿉니다.",
                ],
                ["admin", "관리자", "구성원·팀·초대를 관리합니다."],
                ["member", "구성원", "자기 세션과 맡은 에이전트만 다룹니다."],
              ] as const
            ).map(([value, label, help]) => (
              <Field key={value} orientation="horizontal">
                <RadioGroupItem
                  value={value}
                  disabled={viewer === "admin" && value === "owner"}
                />
                <FieldLabel>{label}</FieldLabel>
                <FieldDescription>
                  {viewer === "admin" && value === "owner"
                    ? "소유자만 소유자를 지정할 수 있습니다."
                    : help}
                </FieldDescription>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button type="button" disabled={ownerGuarded} onClick={onClose}>
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MyTeams() {
  return (
    <>
      <PageHeader
        title="구성원"
        description="내가 속한 팀입니다. 구성원·팀 관리는 소유자와 관리자가 합니다."
      />
      <Card>
        <CardHeader>
          <CardTitle>내 팀</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Badge>플랫폼팀</Badge>
        </CardContent>
      </Card>
    </>
  );
}

type Screen =
  | "members"
  | "members-admin"
  | "members-loading"
  | "members-error"
  | "member-edit"
  | "member-edit-admin"
  | "member-edit-admin-owner"
  | "member-disable"
  | "teams"
  | "teams-empty"
  | "team-create"
  | "team-create-taken"
  | "team"
  | "team-empty"
  | "team-delete"
  | "invites"
  | "invites-empty"
  | "member-view";

const DETAIL_SCREENS: readonly Screen[] = ["team", "team-empty", "team-delete"];

const OWNER = MEMBERS.find((member) => member.id === "u1") ?? null;
const MINJI = MEMBERS.find((member) => member.id === "u3") ?? null;

function MembersScreen({ screen }: { readonly screen: Screen }) {
  const [editing, setEditing] = useState<Member | null>(
    screen === "member-edit" || screen === "member-edit-admin"
      ? MINJI
      : screen === "member-edit-admin-owner"
        ? OWNER
        : null,
  );
  const viewer: Role = screen.includes("-admin")
    ? "admin"
    : screen === "member-view"
      ? "member"
      : "owner";
  const tab: Tab = screen.startsWith("team")
    ? "teams"
    : screen.startsWith("invites")
      ? "invites"
      : "members";
  const crumb =
    tab === "teams"
      ? DETAIL_SCREENS.includes(screen)
        ? ["구성원", "팀", "플랫폼팀"]
        : ["구성원", "팀"]
      : tab === "invites"
        ? ["구성원", "초대"]
        : ["구성원"];
  let body: ReactNode;
  if (screen === "member-view") body = <MyTeams />;
  else {
    // Each tab's one primary action in the head; a team's page has none.
    const action =
      tab !== "teams" ? (
        inviteButton
      ) : DETAIL_SCREENS.includes(screen) ? undefined : (
        <TeamCreateAction
          initialOpen={screen.startsWith("team-create")}
          taken={screen === "team-create-taken"}
        />
      );
    const content =
      tab === "members" ? (
        <MembersTab
          viewer={viewer}
          onEdit={setEditing}
          state={
            screen === "members-loading"
              ? "loading"
              : screen === "members-error"
                ? "error"
                : "ready"
          }
        />
      ) : tab === "invites" ? (
        <InvitesTab empty={screen === "invites-empty"} />
      ) : screen === "team" ||
        screen === "team-empty" ||
        screen === "team-delete" ? (
        <TeamDetailView emptyMembers={screen === "team-empty"} />
      ) : (
        <TeamsTab empty={screen === "teams-empty"} />
      );
    body = (
      <>
        <Head tab={tab} action={action} />
        {content}
      </>
    );
  }
  return (
    <ScreenShell current="members" crumb={crumb} role={viewer}>
      {body}
      {editing ? (
        <MemberEditDialog
          member={editing}
          viewer={viewer}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {screen === "member-disable" ? (
        <ConfirmDialog
          open
          onOpenChange={fn()}
          onConfirm={fn()}
          tone="danger"
          title="Verify Hoon을 비활성화할까요?"
          consequence="로그인과 이 사람의 개인 key가 바로 끊깁니다. 이 사람이 만든 에이전트 key는 계속 동작합니다."
          confirmLabel="비활성화"
        />
      ) : null}
      {screen === "team-delete" ? (
        <DestructiveActionDialog
          open
          onOpenChange={fn()}
          onConfirm={fn()}
          title="플랫폼팀을 삭제할까요?"
          consequence="삭제 전에 확인한 관계: 이 팀이 관리자로 있던 에이전트 3개(release-bot, triage, research)의 관리에서 빠집니다."
          resourceName="플랫폼팀"
        />
      ) : null}
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Members (v3)",
  component: MembersScreen,
  parameters: { layout: "fullscreen" },
  args: { screen: "members" },
} satisfies Meta<typeof MembersScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Members: Story = {};
export const MembersAsAdmin: Story = {
  name: "Members (admin: owner rows locked)",
  args: { screen: "members-admin" },
};
export const MembersLoading: Story = { args: { screen: "members-loading" } };
export const MembersError: Story = { args: { screen: "members-error" } };
export const MemberEdit: Story = {
  name: "Member edit (role)",
  args: { screen: "member-edit" },
};
export const MemberEditAsAdmin: Story = {
  name: "Member edit (admin)",
  args: { screen: "member-edit-admin" },
};
export const MemberEditOwnerAsAdmin: Story = {
  name: "Member edit (admin on an owner: locked)",
  args: { screen: "member-edit-admin-owner" },
};
export const MemberDisable: Story = { args: { screen: "member-disable" } };
export const Teams: Story = { args: { screen: "teams" } };
export const TeamsEmpty: Story = { args: { screen: "teams-empty" } };
export const TeamCreate: Story = {
  name: "Team create (head button → dialog)",
  args: { screen: "team-create" },
};
export const TeamCreateMobile: Story = {
  name: "Team create (390px)",
  args: { screen: "team-create" },
  globals: MOBILE,
};
export const TeamCreateTaken: Story = {
  name: "Team create (name taken)",
  args: { screen: "team-create-taken" },
};
export const TeamDetail: Story = {
  name: "Team detail (A: inside 팀 tab)",
  args: { screen: "team" },
};
export const TeamDetailEmpty: Story = { args: { screen: "team-empty" } };
export const TeamDelete: Story = { args: { screen: "team-delete" } };
export const Invites: Story = { args: { screen: "invites" } };
export const InvitesEmpty: Story = { args: { screen: "invites-empty" } };
export const MemberView: Story = {
  name: "As member (내 팀)",
  args: { screen: "member-view" },
};

export const MembersDark: Story = {
  name: "Members (dark)",
  globals: { theme: "dark" },
};
export const MembersMobile: Story = {
  name: "Members (390px)",
  globals: MOBILE,
};
export const TeamDetailMobileDark: Story = {
  name: "Team detail (390px, dark)",
  args: { screen: "team" },
  globals: { ...MOBILE, theme: "dark" },
};
