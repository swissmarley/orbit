import type { Tone } from '@orbit/core/browser';

/** Token classes for each tone of the shared vocabulary (text on a subtle background). */
export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-neutral bg-neutral-bg',
  info: 'text-info bg-info-bg',
  success: 'text-success bg-success-bg',
  warning: 'text-warning bg-warning-bg',
  danger: 'text-danger bg-danger-bg',
  attention: 'text-attention bg-attention-bg',
};

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-neutral',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  attention: 'text-attention',
};

export const TONE_FILL: Record<Tone, string> = {
  neutral: 'bg-neutral',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  attention: 'bg-attention',
};

/**
 * A status symbol as text: some platforms draw ⏸ as a colour emoji, which
 * drops the tone colour, so it gets VS15 (text presentation).
 */
export function textMark(mark: string): string {
  return mark === '\u23F8' ? '\u23F8\uFE0E' : mark;
}
