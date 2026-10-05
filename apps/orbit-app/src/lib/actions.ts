import type { Bot, BotSpecInput, RunState } from '@orbit/core/browser';
import type { Approval, RouteBody } from '@orbit/sdk-client/browser';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { csrfSecret, errorText, useClient } from './api';
import { keys } from './queries';

/** Undo window for reversible actions. */
export const UNDO_MS = 8000;

function fail(what: string) {
  return (err: unknown) => {
    toast.error(what, { description: errorText(err) });
    throw err;
  };
}

/** Optimistically patch a Bot everywhere it is cached; returns a rollback. */
function patchBot(qc: QueryClient, id: string, patch: (b: Bot) => Bot): () => void {
  const list = qc.getQueryData<Bot[]>(keys.bots);
  const one = qc.getQueryData<Bot>(keys.bot(id));
  qc.setQueryData<Bot[]>(keys.bots, (l) => l?.map((b) => (b.id === id ? patch(b) : b)));
  qc.setQueryData<Bot>(keys.bot(id), (b) => (b ? patch(b) : b));
  return () => {
    qc.setQueryData(keys.bots, list);
    qc.setQueryData(keys.bot(id), one);
  };
}

/** Optimistically drop an approval from the pending lists; returns a rollback. */
function dropApproval(qc: QueryClient, id: string): () => void {
  const snapshot = qc.getQueriesData<Approval[]>({ queryKey: keys.approvals });
  qc.setQueriesData<Approval[]>({ queryKey: keys.approvalList({}) }, (l) =>
    l?.filter((a) => a.id !== id),
  );
  return () => {
    for (const [k, v] of snapshot) qc.setQueryData(k, v);
  };
}

/**
 * Every write the App makes, in one place: optimistic where the outcome is
 * certain, a toast for every result, and Undo for what can be undone
 * (pausing, the kill switch, config edits, revoking a rule). Approval
 * decisions cannot be undone, so they are only made from the full card.
 */
export function useActions() {
  const c = useClient();
  const qc = useQueryClient();
  const navigate = useNavigate();

  return useMemo(() => {
    const refresh = (...ks: (readonly unknown[])[]) =>
      Promise.all(ks.map((k) => qc.invalidateQueries({ queryKey: k })));

    const actions = {
      async runBot(bot: Bot, body: RouteBody<'startRun'> = {}): Promise<RunState> {
        const run = await c.runs
          .start(bot.id, body)
          .catch(fail(`Could not start ${bot.spec.name}`));
        void refresh(keys.runs, keys.queue);
        toast.success(`Queued a run of ${bot.spec.name}`, {
          action: {
            label: 'Open',
            onClick: () => void navigate({ to: '/runs/$runId', params: { runId: run.runId } }),
          },
        });
        return run;
      },

      async setBotPaused(bot: Bot, paused: boolean, undoable = true): Promise<void> {
        const rollback = patchBot(qc, bot.id, (b) => ({
          ...b,
          pausedAt: paused ? new Date().toISOString() : null,
        }));
        try {
          await (paused ? c.bots.pause(bot.id) : c.bots.resume(bot.id));
        } catch (err) {
          rollback();
          fail(`Could not ${paused ? 'pause' : 'resume'} ${bot.spec.name}`)(err);
        } finally {
          void refresh(keys.bots, keys.runs, keys.queue);
        }
        toast.success(paused ? `Paused ${bot.spec.name}` : `Resumed ${bot.spec.name}`, {
          description: paused
            ? 'Its Runs stopped; nothing new starts. Resuming does not restart stopped Runs.'
            : 'It may run again.',
          duration: UNDO_MS,
          ...(undoable
            ? {
                action: {
                  // Undoing a pause cannot bring the stopped Runs back: name what it does.
                  label: paused ? 'Resume Bot' : 'Undo',
                  onClick: () =>
                    void actions.setBotPaused(bot, !paused, false).catch(() => undefined),
                },
              }
            : {}),
        });
      },

      async stopRun(runId: string): Promise<void> {
        await c.runs.stop(runId).catch(fail('Could not stop the run'));
        void refresh(keys.run(runId), keys.runs, keys.queue);
        toast.success('Run stopped');
      },

      async resumeRun(runId: string): Promise<void> {
        await c.runs.resume(runId).catch(fail('Could not resume the run'));
        void refresh(keys.run(runId), keys.runs, keys.queue);
        toast.success('Run queued to resume');
      },

      async approve(
        a: Approval,
        opts: { editedInput?: Record<string, unknown> | null; always?: boolean } = {},
      ): Promise<void> {
        const rollback = dropApproval(qc, a.id);
        try {
          const r = await c.approvals.approve(a.id, {
            ...(opts.editedInput ? { editedInput: opts.editedInput } : {}),
            ...(opts.always
              ? {
                  always: {
                    scope: 'bot',
                    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
                  },
                }
              : {}),
          });
          toast.success(`Approved ${a.card.what}`, {
            description: [
              opts.editedInput ? 'With your edits.' : null,
              opts.always ? `${a.toolName} is allowed for ${a.card.botName} for 7 days.` : null,
              r.resumed ? 'The run resumes.' : null,
            ]
              .filter(Boolean)
              .join(' '),
          });
        } catch (err) {
          rollback();
          fail('Could not approve')(err);
        } finally {
          void refresh(keys.approvals, keys.runs, keys.run(a.runId), keys.rules);
        }
      },

      async deny(a: Approval, reason: string | null): Promise<void> {
        const rollback = dropApproval(qc, a.id);
        try {
          await c.approvals.deny(a.id, { reason });
          toast.success(`Denied ${a.card.what}`, {
            description: reason ? `The Bot sees: “${reason}”` : 'The Bot is told it was denied.',
          });
        } catch (err) {
          rollback();
          fail('Could not deny')(err);
        } finally {
          void refresh(keys.approvals, keys.runs, keys.run(a.runId));
        }
      },

      async setKill(on: boolean, undoable = true): Promise<void> {
        const before = qc.getQueryData(keys.kill);
        qc.setQueryData(keys.kill, { engaged: on, by: on ? 'you' : null });
        try {
          await c.kill.set(on);
        } catch (err) {
          qc.setQueryData(keys.kill, before);
          fail('Could not change the kill switch')(err);
        } finally {
          void refresh(keys.kill, keys.runs, keys.queue, keys.bots);
        }
        toast[on ? 'warning' : 'success'](
          on ? 'Global kill switch engaged' : 'Kill switch released',
          {
            description: on
              ? 'Every Run stopped. Nothing new starts until you release it.'
              : 'Bots may run again.',
            duration: UNDO_MS,
            // Undoing "engage" would let Runs start again: only "release" offers undo.
            ...(undoable && !on
              ? {
                  action: {
                    label: 'Undo',
                    onClick: () => void actions.setKill(true, false).catch(() => undefined),
                  },
                }
              : {}),
          },
        );
      },

      async createBot(spec: BotSpecInput): Promise<Bot> {
        const bot = await c.bots.create(spec).catch(fail('Could not create the Bot'));
        void refresh(keys.bots, keys.schedules);
        toast.success(`Created ${bot.spec.name}`);
        return bot;
      },

      async updateBot(bot: Bot, spec: BotSpecInput, undoable = true): Promise<Bot> {
        const saved = await c.bots.update(bot.id, spec).catch(fail('Could not save the config'));
        void refresh(keys.bots, keys.bot(bot.id), keys.botVersions(bot.id), keys.schedules);
        toast.success(`Saved ${saved.spec.name} as version ${saved.version}`, {
          duration: UNDO_MS,
          ...(undoable
            ? {
                action: {
                  label: 'Undo',
                  onClick: () =>
                    void actions.updateBot(saved, bot.spec, false).catch(() => undefined),
                },
              }
            : {}),
        });
        return saved;
      },

      async createRule(body: RouteBody<'createRule'>) {
        const rule = await c.rules.create(body).catch(fail('Could not create the rule'));
        void refresh(keys.rules);
        toast.success(
          `${rule.effect === 'allow' ? 'Allow' : 'Deny'} rule added for ${rule.toolPattern}`,
        );
        return rule;
      },

      async revokeRule(rule: {
        id: string;
        toolPattern: string;
        effect: 'allow' | 'deny';
        botId: string | null;
        expiresAt: string | null;
        reason: string | null;
      }) {
        await c.rules.revoke(rule.id).catch(fail('Could not revoke the rule'));
        void refresh(keys.rules);
        const restorable = rule.expiresAt === null || Date.parse(rule.expiresAt) > Date.now();
        toast.success(`Revoked the rule for ${rule.toolPattern}`, {
          duration: UNDO_MS,
          ...(restorable
            ? {
                action: {
                  label: 'Undo',
                  onClick: () =>
                    void actions
                      .createRule({
                        toolPattern: rule.toolPattern,
                        effect: rule.effect,
                        bot: rule.botId,
                        expiresAt: rule.expiresAt,
                        reason: rule.reason,
                      })
                      .catch(() => undefined),
                },
              }
            : {}),
        });
      },

      async setSecret(name: string, value: string) {
        await c.secrets.set(name, value).catch(fail('Could not store the secret'));
        void refresh(keys.secrets);
        toast.success(`Stored ${name}`, {
          description: 'Encrypted in the vault; never shown again.',
        });
      },

      async removeSecret(name: string) {
        await c.secrets.remove(name).catch(fail('Could not remove the secret'));
        void refresh(keys.secrets);
        toast.success(`Removed ${name}`);
      },

      async signOut() {
        await c.call('deleteSession').catch(() => undefined);
        csrfSecret.set(null);
        qc.clear();
        window.location.assign('/login');
      },
    };
    return actions;
  }, [c, qc, navigate]);
}
