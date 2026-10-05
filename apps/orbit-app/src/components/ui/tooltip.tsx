/** @jsxRuntime automatic @jsxImportSource react */
import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';

export const TooltipProvider = T.Provider;

/** A hover/focus hint. The trigger must already carry its own accessible text. */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          sideOffset={6}
          className="z-50 max-w-xs rounded-md border border-border bg-surface-3 px-2 py-1 text-xs text-fg shadow-card"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
