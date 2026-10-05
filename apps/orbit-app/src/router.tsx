/** @jsxRuntime automatic @jsxImportSource react */
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  Outlet,
} from '@tanstack/react-router';
import { AppShell } from './components/shell';
import { BotDetailScreen } from './screens/bot-detail';
import { BotsScreen } from './screens/bots';
import { InboxScreen } from './screens/inbox';
import { NewBotScreen } from './screens/new-bot';
import { RunScreen } from './screens/run';
import { RunsScreen } from './screens/runs';
import { SettingsScreen } from './screens/settings';
import { LoginScreen } from './screens/sign-in';
import { WelcomeScreen, onboarded } from './screens/welcome';
import type { QueryClient } from '@tanstack/react-query';
import type { OrbitClient } from '@orbit/sdk-client/browser';
import { keys } from './lib/queries';

export interface RouterContext {
  client: OrbitClient;
  queryClient: QueryClient;
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginScreen,
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: AppShell,
});

/** Home: the first-run welcome when there are no Bots yet, otherwise the Inbox. */
function makeIndex(ctx: () => RouterContext) {
  return createRoute({
    getParentRoute: () => shellRoute,
    path: '/',
    beforeLoad: async () => {
      if (!onboarded()) {
        const { client, queryClient } = ctx();
        const bots = await queryClient
          .query({ queryKey: keys.bots, queryFn: () => client.bots.list() })
          .catch(() => null);
        // TanStack Router's redirect is thrown by design.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (bots?.length === 0) throw redirect({ to: '/welcome' });
      }
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: '/inbox' });
    },
  });
}

export function buildRouter(context: RouterContext) {
  const routeTree = rootRoute.addChildren([
    loginRoute,
    shellRoute.addChildren([
      makeIndex(() => context),
      createRoute({ getParentRoute: () => shellRoute, path: '/welcome', component: WelcomeScreen }),
      createRoute({
        getParentRoute: () => shellRoute,
        path: '/inbox',
        component: InboxScreen,
        validateSearch: (s: Record<string, unknown>) => ({ approval: str(s.approval) }),
      }),
      createRoute({ getParentRoute: () => shellRoute, path: '/bots', component: BotsScreen }),
      createRoute({ getParentRoute: () => shellRoute, path: '/bots/new', component: NewBotScreen }),
      createRoute({
        getParentRoute: () => shellRoute,
        path: '/bots/$botId',
        component: BotDetailScreen,
        validateSearch: (s: Record<string, unknown>) => ({ tab: str(s.tab) }),
      }),
      createRoute({
        getParentRoute: () => shellRoute,
        path: '/runs',
        component: RunsScreen,
        validateSearch: (s: Record<string, unknown>) => ({
          status: str(s.status),
          bot: str(s.bot),
        }),
      }),
      createRoute({ getParentRoute: () => shellRoute, path: '/runs/$runId', component: RunScreen }),
      createRoute({
        getParentRoute: () => shellRoute,
        path: '/settings',
        component: SettingsScreen,
        validateSearch: (s: Record<string, unknown>) => ({ tab: str(s.tab) }),
      }),
    ]),
  ]);
  return createRouter({ routeTree, context, defaultPreload: false, scrollRestoration: true });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof buildRouter>;
  }
}
