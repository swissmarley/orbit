import { z } from 'zod';
import { SUBAGENT_NAME } from './bot';

/**
 * The triage path (ORBIT_TRIAGE_MODEL): post-run summaries and the Create
 * Bot proposal. Every call is metered, capped per day and shown (ADR-012).
 */

/** What the proposal may contain: the owner reviews every field before creating the Bot. */
export const BotProposal = z.object({
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(4000),
  instructions: z.string().max(4000).default(''),
  tools: z.array(z.string().min(1)).max(20).default([]),
  schedule: z
    .object({ cron: z.string().trim().min(1).max(120) })
    .nullable()
    .default(null),
  subagents: z
    .record(
      z.string().regex(SUBAGENT_NAME),
      z.object({
        description: z.string().trim().min(1).max(500),
        prompt: z.string().trim().min(1).max(4000),
        tools: z.array(z.string().min(1)).max(20).optional(),
      }),
    )
    .default({}),
  rationale: z.array(z.string().max(300)).max(10).default([]),
});
export type BotProposal = z.infer<typeof BotProposal>;

/** Built-in tools a proposal may suggest (least privilege; Bash only with a reason). */
export const PROPOSABLE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'WebSearch',
  'WebFetch',
  'Bash',
  'Task',
] as const;

export const TriageCall = z.object({
  id: z.string(),
  purpose: z.enum(['summary', 'bot_proposal']),
  botId: z.string().nullable(),
  runId: z.string().nullable(),
  model: z.string(),
  status: z.enum(['ok', 'failed']),
  inputTokens: z.int(),
  outputTokens: z.int(),
  costUsd: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

export const TriageUsage = z.object({
  callsToday: z.int(),
  limit: z.int(),
  inputTokensToday: z.int(),
  outputTokensToday: z.int(),
  costUsdToday: z.number(),
  recent: z.array(TriageCall),
});
