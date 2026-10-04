import { type Tier, OrbitError, newId } from '@orbit/core';
import { type OrbitDb, schema } from '@orbit/store';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { globToRegExp } from './tiers';

export interface Rule {
  id: string;
  /** null = applies to every Bot. */
  botId: string | null;
  toolPattern: string;
  /** Top-level input fields that must match (glob per field), e.g. {"to": "*@mycompany.com"}. */
  inputMatch: Record<string, string> | null;
  effect: 'allow' | 'deny';
  reason: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface NewRule {
  botId: string | null;
  toolPattern: string;
  inputMatch?: Record<string, string> | null;
  effect: 'allow' | 'deny';
  reason?: string | null;
  createdBy: string;
  expiresAt?: string | null;
}

type Row = typeof schema.rules.$inferSelect;

function toRule(r: Row): Rule {
  return {
    id: r.id,
    botId: r.botId,
    toolPattern: r.toolPattern,
    inputMatch: r.inputPattern ? (JSON.parse(r.inputPattern) as Record<string, string>) : null,
    effect: r.effect === 'deny' ? 'deny' : 'allow',
    reason: r.reason,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  };
}

/**
 * Allow rules may only name an exact tool or `mcp__<server>__<prefix>*` with a
 * literal server and a non-empty literal prefix. Wildcards anywhere else
 * (`*`, `mcp__*`, `*_*`, `?*`) would silently cover tools nobody reviewed.
 */
export function isNarrowAllowPattern(pattern: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(pattern)) return true;
  return /^mcp__[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*__[A-Za-z0-9][A-Za-z0-9_]*\*?$/.test(pattern);
}

export function ruleMatches(rule: Rule, toolName: string, input: Record<string, unknown>): boolean {
  if (!globToRegExp(rule.toolPattern).test(toolName)) return false;
  if (!rule.inputMatch) return true;
  return Object.entries(rule.inputMatch).every(([key, glob]) => {
    const v = input[key];
    return typeof v === 'string' && globToRegExp(glob).test(v);
  });
}

/**
 * Standing, user-authored rules ("Always allow" with scope and expiry, or
 * "never allow"). Only humans create rules; Bots have no path to this table.
 */
export class RuleStore {
  constructor(
    private readonly db: OrbitDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * @param tierOf  tier of the tool pattern's tools, when known; allow rules
   *                can never cover FINANCIAL actions.
   */
  create(input: NewRule, tierOf?: Tier | null): Rule {
    if (input.effect === 'allow' && tierOf === 'FINANCIAL') {
      throw new OrbitError(
        'invalid_input',
        'Financial or irreversible actions can never be allowed by a rule',
      );
    }
    if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) {
      throw new OrbitError('invalid_input', `Invalid expiry: ${input.expiresAt}`);
    }
    if (input.effect === 'allow' && !isNarrowAllowPattern(input.toolPattern)) {
      throw new OrbitError(
        'invalid_input',
        `Allow rules must name one tool, or one server's tools by prefix (mcp__<server>__<prefix>*); "${input.toolPattern}" is too broad`,
      );
    }
    const row = {
      id: newId('rul'),
      botId: input.botId,
      toolPattern: input.toolPattern,
      inputPattern: input.inputMatch ? JSON.stringify(input.inputMatch) : null,
      effect: input.effect,
      reason: input.reason ?? null,
      createdBy: input.createdBy,
      createdAt: this.now().toISOString(),
      // Normalized to UTC so expiry comparisons on ISO strings are correct.
      expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
      revokedAt: null,
    };
    this.db.orm.insert(schema.rules).values(row).run();
    return toRule(row);
  }

  revoke(id: string): Rule {
    const ts = this.now().toISOString();
    const updated = this.db.orm
      .update(schema.rules)
      .set({ revokedAt: ts })
      .where(and(eq(schema.rules.id, id), isNull(schema.rules.revokedAt)))
      .returning()
      .get() as Row | undefined;
    if (!updated) throw new OrbitError('not_found', `Active rule ${id} not found`);
    return toRule(updated);
  }

  list(opts: { botId?: string; includeInactive?: boolean } = {}): Rule[] {
    const now = this.now().toISOString();
    const rows = this.db.orm
      .select()
      .from(schema.rules)
      .where(
        opts.botId ? or(eq(schema.rules.botId, opts.botId), isNull(schema.rules.botId)) : undefined,
      )
      .orderBy(desc(schema.rules.createdAt))
      .all()
      .map(toRule);
    return opts.includeInactive
      ? rows
      : rows.filter((r) => !r.revokedAt && (!r.expiresAt || r.expiresAt > now));
  }

  /** Active rules that match this call; deny rules first. */
  matching(botId: string, toolName: string, input: Record<string, unknown>): Rule[] {
    return this.list({ botId })
      .filter((r) => ruleMatches(r, toolName, input))
      .sort((a, b) => (a.effect === b.effect ? 0 : a.effect === 'deny' ? -1 : 1));
  }
}
