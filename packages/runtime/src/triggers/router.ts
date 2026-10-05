import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Bot,
  type FileTrigger,
  type GitTrigger,
  type SlackTrigger,
  type TriggerRef,
  type TriggerSpec,
  errorMessage,
  isScheduledTrigger,
} from '@orbit/core';
import { isWithin } from '@orbit/sandbox';
import { describeTrigger, triggerKey } from '../scheduler';
import type { FireOutcome } from '../scheduler';
import { type SlackMessage, SlackSocket, type SocketLike } from './slack';
import { type FileChange, FileWatch, type GitCommit, type GitRunner, GitWatch } from './watchers';

/** What an inbound trigger delivers: who it came from (a taint source) and the content. */
export interface InboundContent {
  /** Untrusted source the Run starts tainted with, e.g. `slack:C0123`, `webhook:deploys`. */
  source: string;
  /** Untrusted text (payload, message, file names, commit subjects). */
  text: string;
  /** Orbit-checked facts the Bot may rely on (validated ids only), shown outside the untrusted block. */
  context?: string;
}

export type InboundFire = (
  bot: Bot,
  trigger: TriggerSpec,
  ref: TriggerRef,
  content: InboundContent,
) => FireOutcome;

export interface InboundStatus {
  botId: string;
  botName: string;
  key: string;
  kind: 'webhook' | 'slack' | 'file' | 'git';
  description: string;
  enabled: boolean;
  /** listening | connecting | needs_setup | error | off */
  state: 'listening' | 'connecting' | 'needs_setup' | 'error' | 'off';
  detail: string | null;
  /** Webhooks: the path to POST to (on orbitd's loopback port). */
  path: string | null;
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export interface TriggerRouterDeps {
  bots: () => Bot[];
  fire: InboundFire;
  /** Slack Socket Mode: the app-level token (Slack plugin secret) and API base. */
  slack: { appToken: () => string | undefined; apiUrl: string };
  /** git for a repository, with an allowlisted env. */
  git: (repo: string) => GitRunner;
  /**
   * Orbit's data folder: Bot workspaces inside it are Bot-writable, so their
   * git configuration must never be run by orbitd (M7 safety review M5).
   */
  orbitHome?: string;
  /**
   * True on the subscription engine (CliDriver): a Claude subscription is for
   * its owner's own use, so a Slack trigger must name the users who may start
   * Runs instead of letting a whole channel do it (M7 safety review M6).
   */
  slackNeedsUsers?: () => boolean;
  /** Is the webhook's signing secret set? */
  hasWebhookSecret: (bot: Bot, name: string) => boolean;
  log?: (message: string) => void;
  /** Tests. */
  slackFetch?: typeof fetch;
  slackConnect?: (url: string) => SocketLike;
  gitPollMs?: number;
}

interface Listener {
  botId: string;
  trigger: TriggerSpec;
  stop: () => Promise<void> | void;
  status: () => { state: InboundStatus['state']; detail: string | null };
}

/**
 * Keeps inbound trigger listeners (Slack, files, git) in step with the Bots'
 * specs and turns what they deliver into Runs (ADR-014). Webhooks need no
 * listener: orbitd's `/hooks/<bot>/<trigger>` route verifies and fires them.
 */
export class TriggerRouter {
  private readonly listeners = new Map<string, Listener>();
  private slack: SlackSocket | null = null;

  constructor(private readonly deps: TriggerRouterDeps) {}

  /** Active inbound triggers of Bots that are not paused. */
  private wanted(): Map<string, { bot: Bot; trigger: TriggerSpec }> {
    const out = new Map<string, { bot: Bot; trigger: TriggerSpec }>();
    for (const bot of this.deps.bots()) {
      if (bot.pausedAt) continue;
      for (const trigger of bot.spec.triggers) {
        if (!trigger.enabled || isScheduledTrigger(trigger) || trigger.kind === 'webhook') continue;
        out.set(triggerKey(bot.id, trigger), { bot, trigger });
      }
    }
    return out;
  }

  /** Start listeners for new triggers, stop those whose trigger went away. Cheap to call often. */
  sync(): void {
    const wanted = this.wanted();
    for (const [key, l] of this.listeners) {
      if (!wanted.has(key)) {
        this.listeners.delete(key);
        void Promise.resolve(l.stop()).catch(() => undefined);
      }
    }
    for (const [key, { bot, trigger }] of wanted) {
      if (this.listeners.has(key)) continue;
      if (trigger.kind === 'file') this.listeners.set(key, this.fileListener(bot, trigger));
      else if (trigger.kind === 'git') this.listeners.set(key, this.gitListener(bot, trigger));
    }
    const slackWanted = [...wanted.values()].some((w) => w.trigger.kind === 'slack');
    if (slackWanted && !this.slack) {
      this.slack = new SlackSocket({
        appToken: this.deps.slack.appToken,
        apiUrl: this.deps.slack.apiUrl,
        onMessage: (m) => this.onSlack(m),
        ...(this.deps.slackFetch ? { fetchFn: this.deps.slackFetch } : {}),
        ...(this.deps.slackConnect ? { connect: this.deps.slackConnect } : {}),
        ...(this.deps.log ? { log: this.deps.log } : {}),
      });
      this.slack.start();
    } else if (!slackWanted && this.slack) {
      this.slack.stop();
      this.slack = null;
    }
  }

  /** Restart Slack (e.g. after its token changed). */
  restartSlack(): void {
    this.slack?.stop();
    this.slack = null;
    this.sync();
  }

  async stop(): Promise<void> {
    this.slack?.stop();
    this.slack = null;
    const all = [...this.listeners.values()];
    this.listeners.clear();
    await Promise.all(all.map((l) => Promise.resolve(l.stop()).catch(() => undefined)));
  }

  private fire(bot: Bot, trigger: TriggerSpec, content: InboundContent): void {
    // Fire against the latest spec: the Bot may have been paused or edited meanwhile.
    const current = this.deps.bots().find((b) => b.id === bot.id) ?? bot;
    try {
      const outcome = this.deps.fire(
        current,
        trigger,
        { kind: trigger.kind, source: describeTrigger(trigger) },
        content,
      );
      if (!outcome.fired) {
        this.deps.log?.(
          `${trigger.kind} trigger of ${current.spec.name} skipped: ${outcome.reason}`,
        );
      }
    } catch (err) {
      this.deps.log?.(
        `${trigger.kind} trigger of ${current.spec.name} failed: ${errorMessage(err)}`,
      );
    }
  }

  private fileListener(bot: Bot, trigger: FileTrigger): Listener {
    const w = new FileWatch(trigger, (changes: FileChange[]) =>
      this.fire(bot, trigger, {
        source: `files:${trigger.name ?? trigger.paths[0] ?? 'watched'}`,
        text: [
          `${changes.length} change${changes.length === 1 ? '' : 's'}:`,
          ...changes.slice(0, 50).map((c) => `${c.event} ${c.path}`),
          ...(changes.length > 50 ? [`… and ${changes.length - 50} more`] : []),
        ].join('\n'),
      }),
    );
    w.start();
    return {
      botId: bot.id,
      trigger,
      stop: () => w.stop(),
      status: () =>
        w.error
          ? { state: 'error', detail: w.error }
          : { state: w.ready ? 'listening' : 'connecting', detail: null },
    };
  }

  private gitListener(bot: Bot, trigger: GitTrigger): Listener {
    const home = this.deps.orbitHome;
    if (home !== undefined && isWithin(canonicalPath(trigger.repo), canonicalPath(home))) {
      const detail = `${trigger.repo} is inside Orbit's data folder, where Bots can write; watch the owner's repository instead`;
      return {
        botId: bot.id,
        trigger,
        stop: () => undefined,
        status: () => ({ state: 'error', detail }),
      };
    }
    const w = new GitWatch(
      trigger,
      this.deps.git(trigger.repo),
      (commits: GitCommit[], head: string) =>
        this.fire(bot, trigger, {
          source: `git:${trigger.branch}`,
          context: `Branch ${trigger.branch} of ${trigger.repo} is now at ${head.slice(0, 12)}.`,
          text: [
            `New commits on ${trigger.branch}:`,
            ...commits.map((c) => `${c.sha} ${c.author}: ${c.subject}`),
          ].join('\n'),
        }),
      this.deps.gitPollMs,
    );
    void w.start();
    return {
      botId: bot.id,
      trigger,
      stop: () => w.stop(),
      status: () =>
        w.error
          ? { state: 'error', detail: w.error }
          : { state: w.ready ? 'listening' : 'connecting', detail: null },
    };
  }

  private onSlack(m: SlackMessage): void {
    for (const { bot, trigger } of this.wanted().values()) {
      if (trigger.kind !== 'slack') continue;
      if (!slackMatches(trigger, m)) continue;
      if (this.slackUsersMissing(trigger)) {
        this.deps.log?.(`Slack message for ${bot.spec.name} ignored: the trigger names no users`);
        continue;
      }
      this.fire(bot, trigger, {
        source: `slack:${m.channel}`,
        context: `Slack channel ${m.channel}, message ts ${m.ts}${m.threadTs ? `, thread ${m.threadTs}` : ''}, from user ${m.user}.`,
        text: m.text,
      });
    }
  }

  private slackUsersMissing(trigger: SlackTrigger): boolean {
    return trigger.users.length === 0 && (this.deps.slackNeedsUsers?.() ?? false);
  }

  /** Inbound triggers with their listener state (webhooks included). */
  status(): InboundStatus[] {
    const out: InboundStatus[] = [];
    for (const bot of this.deps.bots()) {
      for (const trigger of bot.spec.triggers) {
        if (isScheduledTrigger(trigger)) continue;
        const key = triggerKey(bot.id, trigger);
        const base = {
          botId: bot.id,
          botName: bot.spec.name,
          key,
          kind: trigger.kind,
          description: describeTrigger(trigger),
          enabled: trigger.enabled && !bot.pausedAt,
          path: trigger.kind === 'webhook' ? `/hooks/${bot.id}/${trigger.name}` : null,
        };
        if (!base.enabled) {
          out.push({
            ...base,
            state: 'off',
            detail: bot.pausedAt ? 'Bot is paused' : 'turned off',
          });
        } else if (trigger.kind === 'webhook') {
          out.push(
            this.deps.hasWebhookSecret(bot, trigger.name)
              ? {
                  ...base,
                  state: 'listening',
                  detail: `signed ${trigger.style === 'github' ? 'GitHub-style' : 'Orbit-style'}`,
                }
              : { ...base, state: 'needs_setup', detail: 'no signing secret yet' },
          );
        } else if (trigger.kind === 'slack' && this.slackUsersMissing(trigger)) {
          out.push({
            ...base,
            state: 'needs_setup',
            detail:
              'name the Slack users who may start Runs ("users"): on your Claude subscription only you may use it',
          });
        } else if (trigger.kind === 'slack') {
          const s = this.slack?.state ?? { state: 'off' as const };
          out.push({
            ...base,
            state:
              s.state === 'connected'
                ? 'listening'
                : s.state === 'connecting'
                  ? 'connecting'
                  : s.state === 'error'
                    ? this.deps.slack.appToken()
                      ? 'error'
                      : 'needs_setup'
                    : 'off',
            detail: s.state === 'error' ? s.message : null,
          });
        } else {
          const l = this.listeners.get(key);
          out.push({ ...base, ...(l ? l.status() : { state: 'off', detail: null }) });
        }
      }
    }
    return out;
  }
}

export function slackMatches(trigger: SlackTrigger, m: SlackMessage): boolean {
  if (!trigger.channels.includes(m.channel)) return false;
  // Slack sends both a message and an app_mention for a mention: take exactly one.
  if (trigger.on === 'mention' ? m.type !== 'app_mention' : m.type !== 'message') return false;
  return trigger.users.length === 0 || trigger.users.includes(m.user);
}
