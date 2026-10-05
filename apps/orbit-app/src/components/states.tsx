/** @jsxRuntime automatic @jsxImportSource react */
import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorText } from '../lib/api';
import { cn } from '../lib/cn';
import { Button } from './ui/button';
import { Skeleton } from './ui/misc';

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong px-6 py-12 text-center',
        className,
      )}
    >
      {icon ? <div className="text-fg-subtle [&_svg]:size-8">{icon}</div> : null}
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {children ? <div className="max-w-md text-sm text-fg-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Something went wrong</p>
        <p className="break-words">{errorText(error)}</p>
      </div>
      {retry ? (
        <Button size="sm" onClick={retry}>
          <RotateCw aria-hidden /> Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Skeleton rows while a list loads (announced once, politely). */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-fg-muted">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
