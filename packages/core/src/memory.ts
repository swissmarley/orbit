import { z } from 'zod';

/**
 * Bot memory (ADR-012). A memory is a short markdown note with provenance:
 * who wrote it, from which Run, and which untrusted sources influenced it.
 *
 * - `owner`      written or reviewed by the human (App, TUI, CLI)
 * - `bot`        written by the Bot through the Orbit `memory_write` tool
 * - `summarizer` the post-run summary (the Run's result, or the triage model)
 * - `feedback`   Orbit's record of a thumbs rating, an edit, an approval or a denial
 *
 * Every memory reaches a model as provenance-tagged data, never as
 * instructions. A memory with `taint` entries came (partly) from untrusted
 * content: it is never injected automatically, and a Run that reads it is
 * tainted with those sources.
 */
export const MemoryKind = z.enum(['note', 'summary', 'feedback', 'fact']);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const MemorySource = z.enum(['owner', 'bot', 'summarizer', 'feedback']);
export type MemorySource = z.infer<typeof MemorySource>;

export const FeedbackSignal = z.enum(['thumbs_up', 'thumbs_down', 'edited', 'approved', 'denied']);
export type FeedbackSignal = z.infer<typeof FeedbackSignal>;

export const MEMORY_LIMITS = {
  titleChars: 200,
  bodyChars: 8000,
  /** What a Bot may write through `memory_write` in one call. */
  botBodyChars: 4000,
  /** `memory_write` calls per Run. */
  botWritesPerRun: 20,
  /** Memories kept per Bot (owner + bot + summaries + feedback): the default of `memory.maxPerBot`. */
  perBot: 1000,
  /** The highest `memory.maxPerBot` the owner can configure. */
  perBotCeiling: 10_000,
  /** The longest `memory.retentionDays`. */
  retentionDaysMax: 3650,
  /** Untrusted sources remembered per memory (and per tainted file). */
  taintSources: 20,
  /** Characters of one untrusted-source name. */
  taintSourceChars: 200,
  /** Characters of one line of a memory export (a body of 8000 characters escaped as JSON fits). */
  exportLineChars: 64_000,
  /** Bytes of one import request. */
  importBytes: 16 * 1024 * 1024,
} as const;

export const Memory = z.object({
  id: z.string(),
  botId: z.string(),
  kind: MemoryKind,
  source: MemorySource,
  title: z.string(),
  /** Markdown. */
  body: z.string(),
  /** Untrusted sources that influenced the text (empty = trusted provenance). */
  taint: z.array(z.string()),
  /** The Run that wrote it (bot notes, summaries, feedback). */
  runId: z.string().nullable(),
  /** The approval the feedback is about. */
  approvalId: z.string().nullable(),
  signal: FeedbackSignal.nullable(),
  /** Pinned memories are always offered to new Runs (owner-only; never when tainted). */
  pinned: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Set when the owner edited the text after it was written. */
  editedAt: z.string().nullable(),
});
export type Memory = z.infer<typeof Memory>;

/** A search hit: the memory plus a highlighted snippet (FTS5) and its rank. */
export const MemoryHit = Memory.extend({ snippet: z.string(), rank: z.number() });
export type MemoryHit = z.infer<typeof MemoryHit>;

const title = z.string().trim().min(1).max(MEMORY_LIMITS.titleChars);
const body = z.string().max(MEMORY_LIMITS.bodyChars);

export const CreateMemoryBody = z.object({
  title,
  body,
  kind: z.enum(['note', 'fact']).default('fact'),
  pinned: z.boolean().default(false),
});

export const UpdateMemoryBody = z.object({
  title: title.optional(),
  body: body.optional(),
  pinned: z.boolean().optional(),
  /**
   * The owner reviewed an untrusted memory and vouches for it: its taint is
   * cleared (audited). Editing alone never clears taint.
   */
  trusted: z.literal(true).optional(),
});

export const FeedbackBody = z.object({
  rating: z.enum(['up', 'down']),
  comment: z.string().trim().max(2000).optional(),
});

/** Who wrote a memory, for every client ("by …"). */
export const MEMORY_SOURCE_WORD: Readonly<Record<MemorySource, string>> = {
  owner: 'you',
  bot: 'the Bot',
  summarizer: 'Orbit (run summary)',
  feedback: 'Orbit (your feedback)',
};

/** What kind of memory it is, in the words every client uses (filters, rows, cards). */
export const MEMORY_KIND_WORD: Readonly<Record<MemoryKind, string>> = {
  note: 'Bot note',
  summary: 'run summary',
  feedback: 'your feedback',
  fact: 'your fact',
};

/** A feedback signal in words. */
export const FEEDBACK_SIGNAL_WORD: Readonly<Record<FeedbackSignal, string>> = {
  thumbs_up: 'rated good',
  thumbs_down: 'rated not good',
  edited: 'edited before approving',
  approved: 'approved',
  denied: 'denied',
};

// ── export / import (ADR-012, M8) ───────────────────────────────────────────

export const MEMORY_EXPORT_KIND = 'orbit-memory-export';
export const MEMORY_EXPORT_VERSION = 1;

/** The first line of a memory export (JSON Lines). */
export const MemoryExportHeader = z.object({
  kind: z.literal(MEMORY_EXPORT_KIND),
  v: z.int().min(1),
  exportedAt: z.string(),
  bots: z.array(z.object({ id: z.string(), name: z.string() })),
  count: z.int().min(0),
});
export type MemoryExportHeader = z.infer<typeof MemoryExportHeader>;

const exportId = z.string().max(64);
const isoTime = z.iso.datetime({ offset: true });

/**
 * One memory in an export: its text and provenance. On import `id` and
 * `botId` are only references (ids are minted anew, the owner names the
 * target Bot); everything else is kept, the text redacted and stripped of
 * control characters like any memory write.
 */
export const MemoryExportLine = z.object({
  id: exportId.optional(),
  botId: exportId.optional(),
  kind: MemoryKind,
  source: MemorySource,
  title: z.string().max(MEMORY_LIMITS.titleChars),
  body: z.string().max(MEMORY_LIMITS.bodyChars),
  taint: z
    .array(z.string().min(1).max(MEMORY_LIMITS.taintSourceChars))
    .max(MEMORY_LIMITS.taintSources)
    .default([]),
  runId: exportId.nullable().default(null),
  approvalId: exportId.nullable().default(null),
  signal: FeedbackSignal.nullable().default(null),
  pinned: z.boolean().default(false),
  createdAt: isoTime,
  updatedAt: isoTime.optional(),
  editedAt: isoTime.nullable().default(null),
});
export type MemoryExportLine = z.infer<typeof MemoryExportLine>;

export const ImportMemoryBody = z.object({
  /** The export file: a header line, then one memory per line. */
  jsonl: z.string().min(1),
  /** Mark every imported memory untrusted (taint `import`), whatever the file says. */
  untrusted: z.boolean().default(false),
  /** Validate and count only; nothing is written. */
  dryRun: z.boolean().default(false),
});

export const MemoryImportResult = z.object({
  dryRun: z.boolean(),
  botId: z.string(),
  /** Memories in the file (all of them valid, or nothing is imported). */
  total: z.int(),
  /** Offered to Runs automatically after import. */
  trusted: z.int(),
  untrusted: z.int(),
  /** Trusted lines that claim to be written by you (`source: owner`): accepted because you import them. */
  claimsOwner: z.int(),
  bySource: z.record(MemorySource, z.int()),
  pinned: z.int(),
  /** Existing Bot notes and summaries dropped to stay within `memory.maxPerBot`. */
  evicts: z.int(),
  /** Ids of the new memories (empty for a dry run). */
  imported: z.array(z.string()),
  /** Lines that failed validation (line numbers are 1-based, the header is line 1). */
  errors: z.array(z.object({ line: z.int(), message: z.string() })),
});
export type MemoryImportResult = z.infer<typeof MemoryImportResult>;

export const MemorySweepResult = z.object({
  /** Unpinned Bot notes and summaries older than the retention period, deleted. */
  expired: z.int(),
  /** Memories dropped to stay within `memory.maxPerBot`. */
  trimmed: z.int(),
  bots: z.array(z.object({ botId: z.string(), expired: z.int(), trimmed: z.int() })),
  maxPerBot: z.int(),
  retentionDays: z.int().nullable(),
});
export type MemorySweepResult = z.infer<typeof MemorySweepResult>;
