/** @jsxRuntime automatic @jsxImportSource react */
import { type Bot, scrubControls, slugify } from '@orbit/core/browser';
import { Check, Copy, SquareTerminal } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useBots, useHealth } from '../lib/queries';
import { useRole } from '../lib/role';
import { createStore, useStore } from '../lib/store';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTrigger } from './ui/dialog';

/** The terminal command that takes over a Bot's workspace (ADR-016). */
export function takeoverCommand(bot: Bot): string {
  return `orbit shell ${slugify(bot.spec.name)}`;
}

/** The Bot whose take-over dialog the palette opened (null: none). */
export const takeoverStore = createStore<string | null>(null);

/**
 * The take-over dialog: the exact command to run in a terminal, with a copy
 * button. The browser never opens a shell itself: what is typed there would
 * bypass Orbit's policy engine, so only the CLI with the bearer token may.
 */
function TakeOverDialog({
  bot,
  open,
  onOpenChange,
  trigger,
}: {
  bot: Bot;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  trigger?: ReactNode;
}) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const health = useHealth();
  // Hosted (ADR-015): the terminal is the Orbit server's, not this browser's machine.
  const hosted = health.data?.signIn === 'oidc';
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
    <Dialog
      {...(open === undefined ? {} : { open })}
      onOpenChange={(o) => {
        setCopied(null);
        onOpenChange?.(o);
      }}
    >
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent
        title={`Take over ${name}`}
        description={
          hosted
            ? "Work in this Bot's workspace yourself, from a terminal on the Orbit server."
            : "Work in this Bot's workspace yourself, from a terminal on this machine."
        }
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
        <p className={copied === 'failed' ? 'mt-1 text-xs text-danger' : 'sr-only'} role="status">
          {copied === 'failed'
            ? 'Could not copy here: select the command and copy it yourself.'
            : ''}
        </p>
        {hosted ? (
          <p className="mt-2 text-sm text-fg" data-testid="takeover-hosted">
            On a hosted Orbit, this is done on the Orbit server by whoever runs it: the command
            needs orbitd's bearer token, which no browser session has. Ask the server's operator, or
            run it there yourself if that is you.
          </p>
        ) : (
          <p className="mt-2 text-sm text-fg">
            The browser does not open a shell: commands typed there would bypass Orbit's policy
            engine, so only the CLI on this machine can.
          </p>
        )}
        <p className="mt-2 text-xs text-fg-muted">
          While the shell is open, none of this Bot's Runs start or resume; pause or stop a running
          Run first. Files you change stay yours (they are not marked untrusted).
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** "Take over": shown to the owner only (the take-over routes are the owner's, ADR-015). */
export function TakeOverButton({ bot, size = 'md' }: { bot: Bot; size?: 'sm' | 'md' }) {
  const role = useRole();
  if (!role.can('startTakeover')) return null;
  const name = scrubControls(bot.spec.name);
  return (
    <TakeOverDialog
      bot={bot}
      trigger={
        <Button size={size} variant="ghost" aria-label={`Take over ${name}`}>
          <SquareTerminal aria-hidden /> Take over
        </Button>
      }
    />
  );
}

/** The dialog the palette opens ("Take over <Bot>…"), mounted once in the shell. */
export function TakeOverHost() {
  const id = useStore(takeoverStore);
  const bots = useBots();
  const role = useRole();
  const bot = id ? bots.data?.find((b) => b.id === id) : undefined;
  if (!bot || !role.can('startTakeover')) return null;
  return (
    <TakeOverDialog
      bot={bot}
      open
      onOpenChange={(o) => (o ? undefined : takeoverStore.set(null))}
    />
  );
}
