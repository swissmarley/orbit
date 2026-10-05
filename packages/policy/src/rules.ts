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

/**
 * An `inputMatch` glob (M2 review L11): `*` stands for one value — any run of
 * characters except whitespace, controls, list separators (`,` `;`), angle
 * brackets and quotes — so `*@mycompany.com` cannot match
 * `"x@evil.com, me@mycompany.com"`; `?` is one such character. Anchored at
 * both ends and case-sensitive (a domain in other case simply asks).
 */
export function inputGlobToRegExp(glob: string): RegExp {
  const one = '[^\\s\\x00-\\x1f\\x7f,;<>"\'`]';
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += `${one}*`;
    else if (ch === '?') re += one;
    else re += ch.replace(/[.+^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** `..` path segments never match: `/notes/*` must not reach `/notes/../../etc`. */
const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;

function valueMatches(glob: string, value: unknown): boolean {
  const one = (v: unknown) =>
    typeof v === 'string' && !TRAVERSAL.test(v) && inputGlobToRegExp(glob).test(v);
  // A list (several recipients) matches only when every entry does.
  if (Array.isArray(value)) return value.length > 0 && value.every(one);
  return one(value);
}

export function ruleMatches(rule: Rule, toolName: string, input: Record<string, unknown>): boolean {
  if (!globToRegExp(rule.toolPattern).test(toolName)) return false;
  if (!rule.inputMatch) return true;
  return Object.entries(rule.inputMatch).every(([key, glob]) => valueMatches(glob, input[key]));
}

/** Validate an `inputMatch` from a client: top-level keys, non-empty globs. */
export function checkInputMatch(match: Record<string, string>): void {
  const entries = Object.entries(match);
  if (entries.length === 0 || entries.length > 10) {
    throw new OrbitError('invalid_input', 'inputMatch needs 1 to 10 fields');
  }
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) {
      throw new OrbitError(
        'invalid_input',
        `inputMatch field "${k}" is not a top-level argument name`,
      );
    }
    if (v.length === 0 || v.length > 500) {
      throw new OrbitError('invalid_input', `inputMatch for "${k}" must be 1 to 500 characters`);
    }
    // A bare "*" only says the field exists: it narrows nothing for an allow rule.
    if (/^[*?]*$/.test(v)) {
      throw new OrbitError(
        'invalid_input',
        `inputMatch for "${k}" must contain literal text (for example *@example.com)`,
      );
    }
  }
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
    if (input.inputMatch) checkInputMatch(input.inputMatch);
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
