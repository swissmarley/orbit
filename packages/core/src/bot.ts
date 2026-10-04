import { z } from 'zod';

/**
 * User-authored Bot configuration. Later milestones extend it with triggers,
 * policy, budgets, plugins and memory settings; every field added must have a
 * safe default so older specs stay valid.
 */
export const BotSpec = z.object({
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(4000),
  instructions: z.string().max(20_000).default(''),
  /** Model alias or ID; falls back to ORBIT_DEFAULT_MODEL. */
  model: z.string().trim().min(1).optional(),
  /** Built-in engine tools exposed to the Bot; omitted = engine default set. */
  tools: z.array(z.string().min(1)).optional(),
  maxTurns: z.int().positive().max(500).optional(),
  /** MockDriver scenario used in demo mode and tests. */
  mock: z.object({ fixture: z.string().min(1) }).optional(),
});
export type BotSpec = z.infer<typeof BotSpec>;
export type BotSpecInput = z.input<typeof BotSpec>;

export const Bot = z.object({
  id: z.string(),
  version: z.int().positive(),
  spec: BotSpec,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Bot = z.infer<typeof Bot>;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 48) || 'bot'
  );
}
