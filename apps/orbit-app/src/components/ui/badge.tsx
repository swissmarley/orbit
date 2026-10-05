/** @jsxRuntime automatic @jsxImportSource react */
import type { Tone } from '@orbit/core/browser';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';
import { TONE_CLASS } from '../../lib/tone';

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'span'> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASS[tone],
        className,
      )}
      {...props}
    />
  );
}
