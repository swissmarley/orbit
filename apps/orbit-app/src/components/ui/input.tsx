/** @jsxRuntime automatic @jsxImportSource react */
import { type ComponentProps, cloneElement, isValidElement } from 'react';
import { cn } from '../../lib/cn';

const field =
  'w-full rounded-md border border-border-input bg-surface px-2.5 text-sm text-fg placeholder:text-fg-subtle focus-visible:border-ring disabled:opacity-60';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(field, 'h-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'min-h-20 py-2 leading-relaxed', className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(field, 'h-8 pr-7', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-xs font-medium text-fg-muted', className)} {...props} />;
}

/** A label, a control and an optional hint, wired together for screen readers. */
export function Field({
  label,
  hint,
  id,
  children,
  className,
}: {
  label: string;
  hint?: string;
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  // Wire the hint to the control for screen readers.
  const control =
    hint && isValidElement<{ 'aria-describedby'?: string }>(children)
      ? cloneElement(children, { 'aria-describedby': `${id}-hint` })
      : children;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={id}>{label}</Label>
      {control}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
