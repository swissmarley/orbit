/** @jsxRuntime automatic @jsxImportSource react */
import { Switch as S } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

/** Loading placeholder with a shimmer (static under reduced motion). */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden
      className={cn(
        'rounded-md bg-[linear-gradient(90deg,var(--surface-2),var(--surface-3),var(--surface-2))] bg-[length:200%_100%] [animation:orbit-shimmer_1.6s_linear_infinite]',
        className,
      )}
      {...props}
    />
  );
}

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-surface-2 px-1 font-mono text-[11px] text-fg-muted',
        className,
      )}
      {...props}
    />
  );
}

export function Switch({ className, ...props }: ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border-strong bg-surface-3 transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <S.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-fg-muted shadow transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-fg" />
    </S.Root>
  );
}

export function Separator({ className }: { className?: string }) {
  return <hr className={cn('border-border', className)} />;
}
