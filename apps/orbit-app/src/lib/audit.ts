import { idPrefix, scrubControls } from '@orbit/core/browser';

/** Where an audit row's subject (or actor) points in the App. */
export type AuditLink =
  | { to: '/runs/$runId'; params: { runId: string } }
  | { to: '/bots/$botId'; params: { botId: string } }
  | { to: '/memory'; search: { memory: string } }
  | { to: '/settings'; search: { tab: string } };

export interface AuditRef {
  /** What a person reads: a Bot name, "run …a1b2c3d4", "memory", the raw id. */
  text: string;
  /** The full id, for titles and screen readers. */
  id: string;
  link: AuditLink | null;
}

const short = (id: string) => `…${id.slice(-8)}`;

/** An id from the audit log as a name and a link (M5 UI review: no raw ids). */
export function auditRef(
  id: string | null,
  botName: (id: string) => string | undefined,
): AuditRef | null {
  if (!id) return null;
  const clean = scrubControls(id);
  switch (idPrefix(id)) {
    case 'bot': {
      const name = botName(id);
      return {
        text: name ? scrubControls(name) : `Bot ${short(clean)}`,
        id: clean,
        link: { to: '/bots/$botId', params: { botId: id } },
      };
    }
    case 'run':
      return {
        text: `run ${short(clean)}`,
        id: clean,
        link: { to: '/runs/$runId', params: { runId: id } },
      };
    case 'mem':
      return {
        text: `memory ${short(clean)}`,
        id: clean,
        link: { to: '/memory', search: { memory: id } },
      };
    case 'rul':
      return {
        text: `rule ${short(clean)}`,
        id: clean,
        link: { to: '/settings', search: { tab: 'policies' } },
      };
    case 'apr':
      return { text: `approval ${short(clean)}`, id: clean, link: null };
    default:
      // Secret names and other plain subjects.
      return { text: clean, id: clean, link: null };
  }
}

/** The actor column: you, Orbit itself, or a Bot by name. */
export function auditActor(actor: string, botName: (id: string) => string | undefined): AuditRef {
  if (actor === 'owner') return { text: 'you', id: actor, link: null };
  if (actor === 'system' || actor === 'orbit') return { text: 'Orbit', id: actor, link: null };
  const bot = /^bot:(.+)$/.exec(actor)?.[1];
  if (bot) {
    const ref = auditRef(bot, botName);
    if (ref) return { ...ref, text: `Bot ${ref.text}` };
  }
  return { text: scrubControls(actor), id: scrubControls(actor), link: null };
}

/** "policy.allowed_by_rule" → "policy · allowed by rule". */
export function auditAction(action: string): string {
  const [area, ...rest] = scrubControls(action).split('.');
  return rest.length ? `${area} · ${rest.join('.').replace(/_/g, ' ')}` : (area ?? '');
}
