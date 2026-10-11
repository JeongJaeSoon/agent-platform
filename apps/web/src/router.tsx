import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { isApiError } from "./api/client.ts";
import { meQuery } from "./api/queries.ts";
import { StatusScreen } from "./components/status-screen.tsx";
import {
  AgentDetailScreen,
  type AgentSearch,
  agentSearch,
} from "./routes/agent-detail.tsx";
import { AgentsScreen, NewAgentScreen } from "./routes/agents.tsx";
import { ApiKeysScreen } from "./routes/api-keys.tsx";
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
import { MembersScreen } from "./routes/members.tsx";
import { TeamDetailScreen, TeamsScreen } from "./routes/teams.tsx";
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

const members = createRoute({
  getParentRoute: () => authed,
  path: "/members",
  component: MembersScreen,
});

const teams = createRoute({
  getParentRoute: () => authed,
  path: "/teams",
  component: TeamsScreen,
});

const team = createRoute({
  getParentRoute: () => authed,
  path: "/teams/$teamId",
  component: TeamDetailScreen,
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
    members,
    teams,
    team,
    agents,
    newAgent,
    agent,
    linkedAccounts,
    slackLink,
    apiKeys,
  ]),
]);

export function createAppRouter(services: Services, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: services,
    ...(history ? { history } : {}),
    defaultPendingComponent: () => <StatusScreen kind="loading" />,
    defaultPendingMs: 150,
    // Query owns server state and its freshness; the router only sequences.
    defaultPreloadStaleTime: 0,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
