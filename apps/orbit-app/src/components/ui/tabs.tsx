/** @jsxRuntime automatic @jsxImportSource react */
import { Tabs as T } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export const Tabs = T.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  return (
    <T.List
      className={cn('flex gap-1 overflow-x-auto border-b border-border', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        '-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-fg-muted hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>) {
  return (
    <T.Content
      className={cn(
        'rounded-sm pt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}
