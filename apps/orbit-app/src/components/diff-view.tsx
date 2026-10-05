/** @jsxRuntime automatic @jsxImportSource react */
import { cn } from '../lib/cn';
import type { DiffLine } from '../lib/diff';

const ROW: Record<DiffLine['kind'], string> = {
  add: 'bg-diff-add text-diff-add-fg',
  del: 'bg-diff-del text-diff-del-fg',
  ctx: 'text-fg-muted',
  hunk: 'bg-surface-2 text-fg-subtle italic',
};
const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: ' ', hunk: '' };
const SPOKEN: Record<DiffLine['kind'], string> = {
  add: 'added',
  del: 'removed',
  ctx: '',
  hunk: '',
};

/** A line diff: +/− signs and words for screen readers, not colour alone. */
export function DiffView({
  lines,
  label,
  className,
  maxHeight = 'max-h-96',
}: {
  lines: DiffLine[];
  label: string;
  className?: string;
  maxHeight?: string;
}) {
  const added = lines.filter((l) => l.kind === 'add').length;
  const removed = lines.filter((l) => l.kind === 'del').length;
  return (
    <figure className={cn('overflow-hidden rounded-md border border-border', className)}>
      <figcaption className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">
        <span className="truncate">{label}</span>
        <span className="shrink-0 tabular-nums">
          <span className="text-success">+{added}</span>{' '}
          <span className="text-danger">−{removed}</span>
        </span>
      </figcaption>
      <div className={cn('overflow-auto font-mono text-xs leading-5', maxHeight)}>
        {lines.length === 0 ? (
          <p className="px-3 py-2 text-fg-subtle">No changes.</p>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className={ROW[l.kind]}>
                  <td className="w-10 px-2 text-right text-fg-subtle select-none">{l.a ?? ''}</td>
                  <td className="w-10 px-2 text-right text-fg-subtle select-none">{l.b ?? ''}</td>
                  <td className="w-4 select-none" aria-hidden>
                    {SIGN[l.kind]}
                  </td>
                  <td className="pr-3 whitespace-pre-wrap break-all">
                    {SPOKEN[l.kind] ? <span className="sr-only">{SPOKEN[l.kind]}: </span> : null}
                    {l.text || ' '}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </figure>
  );
}
