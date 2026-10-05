import type { BotSpecInput, TriggerSpec } from '@orbit/core/browser';

/** Built-in engine tools a Bot can be given (the policy still decides every call). */
export const ENGINE_TOOLS: readonly { name: string; tier: string; does: string }[] = [
  { name: 'Read', tier: 'read', does: 'read files in its workspace' },
  { name: 'Glob', tier: 'read', does: 'find files by name' },
  { name: 'Grep', tier: 'read', does: 'search file contents' },
  { name: 'Write', tier: 'local write', does: 'create files in its workspace' },
  { name: 'Edit', tier: 'local write', does: 'change files in its workspace' },
  { name: 'WebSearch', tier: 'read · untrusted', does: 'search the web (marks the run untrusted)' },
  { name: 'WebFetch', tier: 'read · untrusted', does: 'fetch web pages (marks the run untrusted)' },
  { name: 'Bash', tier: 'external', does: 'run shell commands (always asks you first)' },
];

export interface Proposal {
  spec: BotSpecInput;
  /** Why each choice was made, shown next to it. */
  reasons: string[];
}

const has = (goal: string, ...words: string[]) =>
  words.some((w) => new RegExp(`\\b${w}`, 'i').test(goal));

/** "Summarize my notes every weekday" → "Summarize my notes". */
export function nameFromGoal(goal: string): string {
  const first = goal.trim().split(/[.\n!?]/)[0] ?? '';
  const words = first
    .replace(/\b(every|each|daily|weekly|hourly|on weekdays?|at \d.*)\b.*$/i, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(' ');
  const name = words || 'New Bot';
  return name.charAt(0).toUpperCase() + name.slice(1, 60);
}

/** A schedule the goal asks for, if any. */
export function scheduleFromGoal(goal: string): TriggerSpec | null {
  const at = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(goal);
  let hour = 9;
  let minute = 0;
  if (at) {
    hour = Number(at[1]) % 24;
    minute = Number(at[2] ?? 0) % 60;
    if (at[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (at[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
  }
  const when = `${minute} ${hour}`;
  if (has(goal, 'hourly', 'every hour')) {
    return { kind: 'interval', everyMinutes: 60, enabled: true, name: 'hourly' };
  }
  if (has(goal, 'weekday', 'work ?day', 'business day')) {
    return { kind: 'cron', cron: `${when} * * 1-5`, enabled: true, name: 'weekdays' };
  }
  if (has(goal, 'weekly', 'every week', 'every monday')) {
    return { kind: 'cron', cron: `${when} * * 1`, enabled: true, name: 'weekly' };
  }
  if (
    has(goal, 'daily', 'every day', 'every morning', 'each morning', 'every evening', 'nightly')
  ) {
    const h = has(goal, 'evening', 'nightly') && !at ? 18 : hour;
    return { kind: 'cron', cron: `${minute} ${h} * * *`, enabled: true, name: 'daily' };
  }
  return null;
}

/**
 * A starting configuration from the goal: name, tools and schedule chosen by
 * simple rules, every one explained and editable. Least privilege: read
 * tools by default; writing, web and shell only when the goal needs them.
 */
export function proposeSpec(goal: string): Proposal {
  const reasons: string[] = [];
  const tools = new Set(['Read', 'Glob', 'Grep']);
  reasons.push('Reads its workspace (Read, Glob, Grep) — reading never needs approval.');
  if (
    has(
      goal,
      'write',
      'draft',
      'create',
      'edit',
      'update',
      'summar',
      'report',
      'note',
      'fix',
      'refactor',
      'generate',
    )
  ) {
    tools.add('Write');
    tools.add('Edit');
    reasons.push('Writes files (Write, Edit) — only inside its own workspace.');
  }
  if (
    has(goal, 'web', 'search', 'news', 'research', 'online', 'internet', 'article', 'url', 'site')
  ) {
    tools.add('WebSearch');
    tools.add('WebFetch');
    reasons.push(
      'Uses the web (WebSearch, WebFetch) — web content is untrusted, so anything external it does afterwards always asks you.',
    );
  }
  if (
    has(goal, 'test', 'build', 'run the', 'script', 'command', 'shell', 'git', 'compile', 'lint')
  ) {
    tools.add('Bash');
    reasons.push(
      'Runs commands (Bash) — every command asks you first until sandboxing is verified.',
    );
  }
  const trigger = scheduleFromGoal(goal);
  if (trigger) {
    reasons.push(
      trigger.kind === 'cron'
        ? `Runs on a schedule (${trigger.name}: cron "${trigger.cron}").`
        : `Runs every ${trigger.everyMinutes} minutes.`,
    );
  } else {
    reasons.push('No schedule: it runs when you start it (add one any time).');
  }
  return {
    spec: {
      name: nameFromGoal(goal),
      goal: goal.trim(),
      instructions: '',
      tools: [...tools],
      triggers: trigger ? [trigger] : [],
    },
    reasons,
  };
}
