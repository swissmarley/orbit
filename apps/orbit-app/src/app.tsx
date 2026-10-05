/** @jsxRuntime automatic @jsxImportSource react */
import type { OrbitClient } from '@orbit/sdk-client/browser';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Toaster } from 'sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { ClientContext, authStore, isUnauthorized } from './lib/api';
import { useStore } from './lib/store';
import { effectiveTheme, themeStore } from './lib/theme';
import { buildRouter } from './router';

export function makeQueryClient(): QueryClient {
  const onError = (err: unknown) => {
    if (isUnauthorized(err)) authStore.set('signed-out');
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        // Live events keep data fresh; refetch on focus catches anything missed.
        staleTime: 15_000,
        retry: (count, err) => !isUnauthorized(err) && count < 2,
      },
    },
  });
}

export function App({ client, queryClient }: { client: OrbitClient; queryClient?: QueryClient }) {
  const qc = useMemo(() => queryClient ?? makeQueryClient(), [queryClient]);
  const router = useMemo(() => buildRouter({ client, queryClient: qc }), [client, qc]);
  const theme = useStore(themeStore);
  return (
    <ClientContext.Provider value={client}>
      <QueryClientProvider client={qc}>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
          <Toaster
            theme={effectiveTheme(theme)}
            position="bottom-right"
            closeButton
            richColors={false}
            toastOptions={{ className: 'orbit-toast' }}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </ClientContext.Provider>
  );
}
