import {
  type Bot,
  BotSpec,
  type BotSpecInput,
  OrbitError,
  type Redactor,
  newId,
  slugify,
} from '@orbit/core';
import { and, asc, eq, or } from 'drizzle-orm';
import type { OrbitDb } from './db';
import { botVersions, bots } from './schema';

type BotRow = typeof bots.$inferSelect;

function toBot(row: BotRow): Bot {
  return {
    id: row.id,
    version: row.version,
    spec: BotSpec.parse(row.spec),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    pausedAt: row.pausedAt ?? null,
  };
}

/** Bots with versioned configuration: every update appends a new version. */
export class BotRepo {
  constructor(
    private readonly db: OrbitDb,
    private readonly now: () => Date = () => new Date(),
    /** Specs are user-authored but may contain pasted secrets: stored redacted. */
    private readonly redactor?: Redactor,
  ) {}

  private parseSpec(input: BotSpecInput): BotSpec {
    const spec = BotSpec.parse(input);
    return this.redactor ? BotSpec.parse(this.redactor.redact(spec)) : spec;
  }

  create(input: BotSpecInput): Bot {
    const spec = this.parseSpec(input);
    const slug = slugify(spec.name);
    if (this.find(slug)) {
      throw new OrbitError('invalid_input', `A bot named "${spec.name}" already exists`);
    }
    const ts = this.now().toISOString();
    const id = newId('bot');
    this.db.sqlite.transaction(() => {
      this.db.orm
        .insert(bots)
        .values({ id, name: spec.name, slug, version: 1, spec, createdAt: ts, updatedAt: ts })
        .run();
      this.db.orm.insert(botVersions).values({ botId: id, version: 1, spec, createdAt: ts }).run();
    })();
    return { id, version: 1, spec, createdAt: ts, updatedAt: ts, pausedAt: null };
  }

  update(idOrSlug: string, input: BotSpecInput): Bot {
    const current = this.get(idOrSlug);
    const spec = this.parseSpec(input);
    const slug = slugify(spec.name);
    const clash = this.find(slug);
    if (clash && clash.id !== current.id) {
      throw new OrbitError('invalid_input', `A bot named "${spec.name}" already exists`);
    }
    const ts = this.now().toISOString();
    const version = current.version + 1;
    this.db.sqlite.transaction(() => {
      this.db.orm
        .update(bots)
        .set({ name: spec.name, slug, version, spec, updatedAt: ts })
        .where(eq(bots.id, current.id))
        .run();
      this.db.orm
        .insert(botVersions)
        .values({ botId: current.id, version, spec, createdAt: ts })
        .run();
    })();
    return { ...current, version, spec, updatedAt: ts };
  }

  /** Bot kill switch. Returns the updated Bot. */
  setPaused(idOrSlug: string, paused: boolean): Bot {
    const bot = this.get(idOrSlug);
    const pausedAt = paused ? (bot.pausedAt ?? this.now().toISOString()) : null;
    this.db.orm.update(bots).set({ pausedAt }).where(eq(bots.id, bot.id)).run();
    return { ...bot, pausedAt };
  }

  find(idOrSlug: string): Bot | undefined {
    const row = this.db.orm
      .select()
      .from(bots)
      .where(or(eq(bots.id, idOrSlug), eq(bots.slug, slugify(idOrSlug))))
      .get();
    return row ? toBot(row) : undefined;
  }

  get(idOrSlug: string): Bot {
    const bot = this.find(idOrSlug);
    if (!bot) throw new OrbitError('not_found', `Bot "${idOrSlug}" not found`);
    return bot;
  }

  list(): Bot[] {
    return this.db.orm.select().from(bots).orderBy(asc(bots.name)).all().map(toBot);
  }

  versions(idOrSlug: string): { version: number; spec: BotSpec; createdAt: string }[] {
    const bot = this.get(idOrSlug);
    return this.db.orm
      .select()
      .from(botVersions)
      .where(and(eq(botVersions.botId, bot.id)))
      .orderBy(asc(botVersions.version))
      .all()
      .map((r) => ({ version: r.version, spec: BotSpec.parse(r.spec), createdAt: r.createdAt }));
  }
}
