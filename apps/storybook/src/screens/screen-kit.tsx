import {
  Badge,
  Button,
  Card,
  CardContent,
  DisabledReason,
  PageFrame,
} from "@werft-ai/ui";
import { type ReactNode, useId } from "react";

/*
 * Shared frame for the v3 screen stories (.design/v3-members/plan.md §9).
 * Screens are assembled from packages/ui and @werft-ai/react only. Where a
 * part does not exist yet, the closest existing part stands in and
 * <PartRequest> names the part asked of the ui-kit lead, so ui-review can
 * tell a stand-in from a finished screen.
 */

export function PartRequest({ name }: { readonly name: string }) {
  return (
    <Badge variant="amber" data-part-request={name}>
      부품 요청 중: {name}
    </Badge>
  );
}

export type NavKey =
  | "home"
  | "sessions"
  | "agents"
  | "members"
  | "settings"
  | "usage"
  | "profiles"
  | "operations";

const NAV: readonly (readonly [NavKey, string])[] = [
  ["home", "홈"],
  ["sessions", "세션"],
  ["agents", "에이전트"],
];
const WORKSPACE_NAV: readonly (readonly [NavKey, string])[] = [
  ["profiles", "실행 프로필"],
  ["operations", "사용량·한도"],
  ["members", "구성원"],
  ["settings", "설정"],
];

function NavItem({
  label,
  current,
}: {
  readonly label: string;
  readonly current: boolean;
}) {
  return (
    <Button
      asChild
      variant={current ? "secondary" : "ghost"}
      className="w-full justify-start"
    >
      <a href="#nav" aria-current={current ? "page" : undefined}>
        {label}
      </a>
    </Button>
  );
}

/**
 * Stand-in for AppShell: the sidebar has no '팀' item (M-01) and the topbar
 * has no '새로 만들기' (C-01). Below md the sidebar is hidden as in the console.
 * Every screen sits in the console's `PageFrame` (V4-PAGE-FRAME) except a
 * session's detail, which lays out its rail and body itself: `flush`.
 */
export function ScreenShell({
  current,
  crumb,
  role = "owner",
  flush = false,
  children,
}: {
  readonly current: NavKey;
  readonly crumb: readonly string[];
  readonly role?: "owner" | "admin" | "member";
  readonly flush?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen text-body">
      <nav
        aria-label="사이드바"
        className="hidden w-[236px] flex-none flex-col gap-1 p-2 md:flex"
      >
        <Card className="flex flex-col gap-1 p-2">
          <PartRequest name="AppShell" />
          {NAV.map(([key, label]) => (
            <NavItem key={key} label={label} current={current === key} />
          ))}
          <p className="m-0 px-3 pt-4 text-caption text-muted-foreground">
            워크스페이스
          </p>
          {WORKSPACE_NAV.filter(
            ([key]) =>
              role !== "member" || (key !== "members" && key !== "settings"),
          ).map(([key, label]) => (
            <NavItem key={key} label={label} current={current === key} />
          ))}
        </Card>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 w-full items-center gap-2 px-4 md:px-6">
          <p className="m-0 text-muted-foreground">{crumb.join(" › ")}</p>
        </header>
        {flush ? (
          <main className="flex w-full flex-1 flex-col border-t">
            <div
              data-slot="page-flush"
              className="flex w-full min-w-0 flex-1 flex-col"
            >
              {children}
            </div>
          </main>
        ) : (
          <main className="flex w-full flex-1 flex-col">
            <PageFrame className="flex-1">{children}</PageFrame>
          </main>
        )}
      </div>
    </div>
  );
}

/**
 * A withheld action: the disabled button stays in line with its row and says
 * why on hover or focus, above it, as the members table does.
 */
export function LockedButton({
  label,
  reason,
  size = "sm",
}: {
  readonly label: string;
  readonly reason: string;
  readonly size?: "sm" | "default";
}) {
  return (
    <DisabledReason reason={reason} label={label}>
      <Button type="button" variant="outline" size={size} disabled={true}>
        {label}
      </Button>
    </DisabledReason>
  );
}

export const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export interface DangerRow {
  readonly title: string;
  readonly body: string;
  /** A string is an outline button in the danger tone. */
  readonly action: ReactNode;
}

/** Stand-in for DangerZone: the last block of a detail screen (C-12). */
export function DangerArea({ rows }: { readonly rows: readonly DangerRow[] }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id={headingId} className="m-0 font-semibold">
          위험 영역
        </h2>
        <PartRequest name="DangerZone" />
      </div>
      <Card className="gap-0 divide-y border-(color:--ap-tone-danger-border) py-0">
        {rows.map((row) => (
          <CardContent
            key={row.title}
            className="flex flex-wrap items-center justify-between gap-4 py-4"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="font-semibold">{row.title}</span>
              <span className="text-muted-foreground">{row.body}</span>
            </div>
            {typeof row.action === "string" ? (
              <Button
                type="button"
                variant="outline"
                className="text-(color:--ap-tone-danger-fg)"
              >
                {row.action}
              </Button>
            ) : (
              row.action
            )}
          </CardContent>
        ))}
      </Card>
    </section>
  );
}
