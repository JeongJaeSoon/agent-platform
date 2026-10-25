import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { isApiError } from "@werft-ai/client";
import { meQuery } from "./api/queries.ts";
import { Main } from "./components/main.tsx";
import { StatusScreen } from "./components/status-screen.tsx";
import {
  AgentDetailScreen,
  type AgentSearch,
  agentSearch,
} from "./routes/agent-detail.tsx";
import { AgentsScreen, NewAgentScreen } from "./routes/agents.tsx";
import {
  AgentKeysScreen,
  ApiKeysScreen,
  NewAgentKeyScreen,
  NewApiKeyScreen,
  OrgKeysScreen,
} from "./routes/api-keys.tsx";
import { BootstrapScreen } from "./routes/bootstrap.tsx";
import {
  GoogleCallbackScreen,
  type GoogleCallbackSearch,
  googleCallbackSearch,
} from "./routes/google-callback.tsx";
import { HomeScreen } from "./routes/home.tsx";
import { InviteScreen } from "./routes/invite.tsx";
import { AuthedError, AuthedLayout, RootLayout } from "./routes/layout.tsx";
import {
  LinkedAccountsScreen,
  SlackLinkCallbackScreen,
  type SlackLinkSearch,
  slackLinkSearch,
} from "./routes/linked-accounts.tsx";
import { LoginScreen, type LoginSearch, loginSearch } from "./routes/login.tsx";
import {
  InvitesScreen,
  MembersLayout,
  MembersScreen,
} from "./routes/members.tsx";
import {
  type OperationsSearch,
  operationsSearch,
} from "./routes/operations-search.ts";
import { PreferencesScreen } from "./routes/preferences.tsx";
import {
  SessionDetailScreen,
  SessionsScreen,
  type SessionsSearch,
  sessionsSearch,
} from "./routes/sessions.tsx";
import { TeamDetailScreen, TeamsScreen } from "./routes/teams.tsx";
import { UsageScreen } from "./routes/usage.tsx";
import { WorkspaceSettingsScreen } from "./routes/workspace-settings.tsx";
import { WorkspaceSlackScreen } from "./routes/workspace-slack.tsx";
import type { Services } from "./services.tsx";

/*
 * The route tree, assembled here and nowhere else. A screen lives in
 * routes/<name>.tsx and exports a component; adding one is a file there and
 * a createRoute below. Everything behind a login hangs off `authed`.
 */

const root = createRootRouteWithContext<Services>()({
  component: RootLayout,
});

const login = createRoute({
  getParentRoute: () => root,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): LoginSearch =>
    loginSearch(search),
  component: LoginScreen,
});

const bootstrap = createRoute({
  getParentRoute: () => root,
  path: "/bootstrap",
  component: BootstrapScreen,
});

// Public: Google sends the browser back here (GOOGLE_OIDC_REDIRECT_URI).
const googleCallback = createRoute({
  getParentRoute: () => root,
  path: "/auth/google/callback",
  validateSearch: (search: Record<string, unknown>): GoogleCallbackSearch =>
    googleCallbackSearch(search),
  component: GoogleCallbackScreen,
});

// Public: whoever opens an invite link may not have an account yet.
const invite = createRoute({
  getParentRoute: () => root,
  path: "/invite/$token",
  component: InviteScreen,
});

const authed = createRoute({
  getParentRoute: () => root,
  id: "authed",
  beforeLoad: async ({ context, location }) => {
    try {
      // A cached principal is checked again once stale, so a session that
      // ended elsewhere does not keep the old identity on screen.
      await context.queryClient.ensureQueryData({
        ...meQuery(context.client),
        revalidateIfStale: true,
      });
    } catch (error) {
      if (isApiError(error, "UNAUTHORIZED")) {
        throw redirect({
          to: "/login",
          search: { redirect: location.href },
        });
      }
      throw error;
    }
  },
  component: AuthedLayout,
  errorComponent: AuthedError,
});

const home = createRoute({
  getParentRoute: () => authed,
  path: "/",
  component: HomeScreen,
});

// 구성원, 팀 and 초대 are tabs of one page (v3 M-01); a team opens inside
// the 팀 tab (M-03).
const members = createRoute({
  getParentRoute: () => authed,
  path: "/members",
  component: MembersLayout,
});

const memberList = createRoute({
  getParentRoute: () => members,
  path: "/",
  component: MembersScreen,
});

const teams = createRoute({
  getParentRoute: () => members,
  path: "teams",
  component: TeamsScreen,
});

const team = createRoute({
  getParentRoute: () => members,
  path: "teams/$teamId",
  component: TeamDetailScreen,
});

const invites = createRoute({
  getParentRoute: () => members,
  path: "invites",
  component: InvitesScreen,
});

// Where teams lived before they joined 구성원: bookmarks still land.
const oldTeams = createRoute({
  getParentRoute: () => authed,
  path: "/teams",
  beforeLoad: () => {
    throw redirect({ to: "/members/teams", replace: true });
  },
});

const oldTeam = createRoute({
  getParentRoute: () => authed,
  path: "/teams/$teamId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/members/teams/$teamId",
      params: { teamId: params.teamId },
      replace: true,
    });
  },
});

const sessions = createRoute({
  getParentRoute: () => authed,
  path: "/sessions",
  validateSearch: (search: Record<string, unknown>): SessionsSearch =>
    sessionsSearch(search),
  component: SessionsScreen,
});

const session = createRoute({
  getParentRoute: () => authed,
  path: "/sessions/$id",
  component: SessionDetailScreen,
});

const linkedAccounts = createRoute({
  getParentRoute: () => authed,
  path: "/settings/linked-accounts",
  component: LinkedAccountsScreen,
});

// Slack sends the browser back here (SLACK_OIDC_REDIRECT_URI).
const slackLink = createRoute({
  getParentRoute: () => authed,
  path: "/settings/linked-accounts/slack",
  validateSearch: (search: Record<string, unknown>): SlackLinkSearch =>
    slackLinkSearch(search),
  component: SlackLinkCallbackScreen,
});

const apiKeys = createRoute({
  getParentRoute: () => authed,
  path: "/settings/api-keys",
  component: ApiKeysScreen,
});

const newApiKey = createRoute({
  getParentRoute: () => authed,
  path: "/settings/api-keys/new",
  component: NewApiKeyScreen,
});

const agentKeys = createRoute({
  getParentRoute: () => authed,
  path: "/settings/api-keys/agents",
  component: AgentKeysScreen,
});

const newAgentKey = createRoute({
  getParentRoute: () => authed,
  path: "/settings/api-keys/agents/new",
  component: NewAgentKeyScreen,
});

// Where the organization key lived before it joined the workspace settings.
const oldOrgKeys = createRoute({
  getParentRoute: () => authed,
  path: "/settings/api-keys/org",
  beforeLoad: () => {
    throw redirect({ to: "/settings/workspace/api-keys", replace: true });
  },
});

const preferences = createRoute({
  getParentRoute: () => authed,
  path: "/settings/preferences",
  component: PreferencesScreen,
});

const workspaceSettings = createRoute({
  getParentRoute: () => authed,
  path: "/settings/workspace",
  component: WorkspaceSettingsScreen,
});

const workspaceSlack = createRoute({
  getParentRoute: () => authed,
  path: "/settings/workspace/slack",
  component: WorkspaceSlackScreen,
});

const orgKeys = createRoute({
  getParentRoute: () => authed,
  path: "/settings/workspace/api-keys",
  component: OrgKeysScreen,
});

const usage = createRoute({
  getParentRoute: () => authed,
  path: "/usage",
  component: UsageScreen,
});

const loadOperations = () => import("./routes/operations.tsx");

const operations = createRoute({
  getParentRoute: () => authed,
  path: "/operations",
  component: lazyRouteComponent(loadOperations, "OperationsLayout"),
});

const operationsOverview = createRoute({
  getParentRoute: () => operations,
  path: "/",
  validateSearch: (search: Record<string, unknown>): OperationsSearch =>
    operationsSearch(search),
  component: lazyRouteComponent(loadOperations, "OperationsOverviewScreen"),
});

const operationsLimits = createRoute({
  getParentRoute: () => operations,
  path: "limits",
  component: lazyRouteComponent(loadOperations, "OperationsLimitsScreen"),
});

const agents = createRoute({
  getParentRoute: () => authed,
  path: "/agents",
  component: AgentsScreen,
});

const newAgent = createRoute({
  getParentRoute: () => authed,
  path: "/agents/new",
  component: NewAgentScreen,
});

const agent = createRoute({
  getParentRoute: () => authed,
  path: "/agents/$id",
  validateSearch: (search: Record<string, unknown>): AgentSearch =>
    agentSearch(search),
  component: AgentDetailScreen,
});

const routeTree = root.addChildren([
  login,
  bootstrap,
  googleCallback,
  invite,
  authed.addChildren([
    home,
    members.addChildren([memberList, teams, team, invites]),
    oldTeams,
    oldTeam,
    agents,
    newAgent,
    agent,
    sessions,
    session,
    linkedAccounts,
    slackLink,
    apiKeys,
    newApiKey,
    agentKeys,
    newAgentKey,
    oldOrgKeys,
    preferences,
    workspaceSettings,
    workspaceSlack,
    orgKeys,
    usage,
    operations.addChildren([operationsOverview, operationsLimits]),
  ]),
]);

export function createAppRouter(services: Services, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: services,
    ...(history ? { history } : {}),
    // Only the authed gate's principal check makes a route wait.
    defaultPendingComponent: () => <StatusScreen kind="checking-login" />,
    defaultPendingMs: 150,
    defaultNotFoundComponent: () => (
      <Main className="web-auth">
        <StatusScreen kind="not-found" />
      </Main>
    ),
    // Query owns server state and its freshness; the router only sequences.
    defaultPreloadStaleTime: 0,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
