/** @jsxRuntime automatic @jsxImportSource react */
import { useMemo } from 'react';
import { cn } from '../lib/cn';
import { type Block, type Inline, parseMarkdown } from '../lib/markdown';

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((s, i) => {
        switch (s.t) {
          case 'text':
            return <span key={i}>{s.v}</span>;
          case 'strong':
            return (
              <strong key={i} className="font-semibold text-fg">
                <Spans spans={s.c} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <Spans spans={s.c} />
              </em>
            );
          case 'code':
            return (
              <code
                key={i}
                className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em] text-fg"
              >
                {s.v}
              </code>
            );
          case 'link':
            // Shown, never followed: the address is visible and selectable (ADR-020).
            return s.label === s.url ? (
              <span
                key={i}
                className="break-all underline decoration-border-strong decoration-dotted"
              >
                {s.url}
              </span>
            ) : (
              <span key={i}>
                {s.label}{' '}
                <span className="break-all text-fg-muted" title={s.url}>
                  ({s.url})
                </span>
              </span>
            );
        }
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case 'p':
      return (
        <p className="whitespace-pre-wrap">
          <Spans spans={block.c} />
        </p>
      );
    case 'h': {
      const cls = cn(
        'font-semibold tracking-tight text-fg',
        block.level === 1 ? 'text-lg' : block.level === 2 ? 'text-base' : 'text-sm',
      );
      // Headings inside a message must not join the page outline: a styled paragraph.
      return (
        <p className={cls}>
          <Spans spans={block.c} />
        </p>
      );
    }
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          className={cn('flex flex-col gap-1 pl-5', block.ordered ? 'list-decimal' : 'list-disc')}
          {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}
        >
          {block.items.map((item, i) => (
            <li key={i} className="pl-0.5 marker:text-fg-subtle">
              <Spans spans={item.c} />
              {item.sub ? (
                item.sub.ordered ? (
                  <ol className="mt-1 flex list-decimal flex-col gap-1 pl-5">
                    {item.sub.items.map((s, j) => (
                      <li key={j}>
                        <Spans spans={s} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <ul className="mt-1 flex list-[circle] flex-col gap-1 pl-5">
                    {item.sub.items.map((s, j) => (
                      <li key={j}>
                        <Spans spans={s} />
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
            </li>
          ))}
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote className="border-l-2 border-border-strong pl-3 whitespace-pre-wrap text-fg-muted">
          <Spans spans={block.c} />
        </blockquote>
      );
    case 'code':
      return (
        <pre
          tabIndex={0}
          className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[13px] leading-relaxed text-fg"
        >
          {block.v}
        </pre>
      );
    case 'hr':
      return <hr className="border-border" />;
  }
}

/** A Bot's message: a small markdown subset rendered as elements, never as HTML. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={cn('flex min-w-0 flex-col gap-2.5 break-words', className)}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}
