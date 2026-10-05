/** @jsxRuntime automatic @jsxImportSource react */
import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  wide = false,
  ...props
}: ComponentProps<typeof D.Content> & {
  title: ReactNode;
  description?: ReactNode;
  wide?: boolean;
}) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]" />
      <D.Content
        className={cn(
          'fixed top-[8vh] left-1/2 z-50 flex max-h-[84vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-lg border border-border bg-surface shadow-card focus:outline-none',
          wide ? 'max-w-3xl' : 'max-w-lg',
          className,
        )}
        {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <D.Title className="text-base font-semibold text-fg">{title}</D.Title>
            {description !== undefined ? (
              <D.Description className="mt-0.5 text-sm text-fg-muted">{description}</D.Description>
            ) : null}
          </div>
          <D.Close
            className="-mr-1 rounded-md p-1 text-fg-muted hover:bg-surface-2 hover:text-fg"
            aria-label="Close"
          >
            <X className="size-4" />
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3',
        className,
      )}
      {...props}
    />
  );
}
