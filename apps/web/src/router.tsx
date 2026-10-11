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
import { BootstrapScreen } from "./routes/bootstrap.tsx";
import { HomeScreen } from "./routes/home.tsx";
import { InviteScreen } from "./routes/invite.tsx";
import { AuthedError, AuthedLayout, RootLayout } from "./routes/layout.tsx";
import { LoginScreen, type LoginSearch, loginSearch } from "./routes/login.tsx";
import { MembersScreen } from "./routes/members.tsx";
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

const routeTree = root.addChildren([
  login,
  bootstrap,
  invite,
  authed.addChildren([home, members]),
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
