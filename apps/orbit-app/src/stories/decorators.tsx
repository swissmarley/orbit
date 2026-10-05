/** @jsxRuntime automatic @jsxImportSource react */
import type { Decorator } from '@storybook/react-vite';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { TooltipProvider } from '../components/ui/tooltip';

/** Components with links need a router: render the story as the only route. */
export const withRouter: Decorator = (Story) => {
  const root = createRootRoute({ component: () => <Story /> });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return (
    <TooltipProvider>
      <RouterProvider router={router as never} />
    </TooltipProvider>
  );
};
