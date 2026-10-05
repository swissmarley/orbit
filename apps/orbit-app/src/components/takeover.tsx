/** @jsxRuntime automatic @jsxImportSource react */
import { type Bot, scrubControls, slugify } from '@orbit/core/browser';
import { Check, Copy, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTrigger } from './ui/dialog';

/** The terminal command that takes over a Bot's workspace (ADR-016). */
export function takeoverCommand(bot: Bot): string {
  return `orbit shell ${slugify(bot.spec.name)}`;
}

/**
 * "Take over": the exact command to run in a terminal, with a copy button.
 * The browser never opens a shell itself: what is typed there would bypass
 * Orbit's policy engine, so only the local CLI with the bearer token may.
 */
export function TakeOverButton({ bot, size = 'md' }: { bot: Bot; size?: 'sm' | 'md' }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const name = scrubControls(bot.spec.name);
  const command = takeoverCommand(bot);
  const copy = () => {
    // The Clipboard API needs a secure context; loopback counts, older shells may not.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(command))
      .then(
        () => setCopied('yes'),
        () => setCopied('failed'),
      );
  };
  return (
    <Dialog onOpenChange={() => setCopied(null)}>
      <DialogTrigger asChild>
        <Button size={size} variant="ghost" aria-label={`Take over ${name}`}>
          <SquareTerminal aria-hidden /> Take over
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Take over ${name}`}
        description="Work in this Bot's workspace yourself, from a terminal on this machine."
      >
        <div className="flex flex-wrap items-center gap-2">
          <code
            className="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-fg select-all"
            data-testid="takeover-command"
          >
            {command}
          </code>
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied === 'yes' ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied === 'yes' ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="mt-1 min-h-4 text-xs text-fg-muted" role="status">
          {copied === 'failed'
            ? 'Could not copy here: select the command and copy it yourself.'
            : ''}
        </p>
        <p className="mt-2 text-sm text-fg">
          The browser does not open a shell: commands typed there would bypass Orbit's policy
          engine, so only the CLI on this machine can.
        </p>
        <p className="mt-2 text-xs text-fg-muted">
          While the shell is open, none of {name}'s Runs start or resume; pause or stop a running
          Run first. Files you change stay yours (they are not marked untrusted).
        </p>
      </DialogContent>
    </Dialog>
  );
}
