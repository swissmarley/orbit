import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from '../test/harness';

let current: Harness | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

interface Checkpoint {
  kind: string;
  v: number;
  seq: number;
  hash: string;
  ts: string;
  count: number;
  mac: string;
}

describe('keyed audit chain over the API (ADR-007, M8)', () => {
  it('keys every record with a key kept outside the database, and never logs it', async () => {
    const lines: string[] = [];
    const h = (current = harness({ service: { log: (_l, m) => lines.push(m) } }));
    await h.json('POST', '/v1/rules', {
      toolPattern: 'mcp__slack__post_message',
      effect: 'allow',
      expiresAt: null,
    });
    const keyFile = join(h.home, 'audit.key');
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
    expect(key).toHaveLength(32);

    const status = await h.json<{ keyed: boolean; count: number; keyedSince: unknown }>(
      'GET',
      '/v1/audit/status',
    );
    expect(status.body).toMatchObject({
      keyed: true,
      count: 1,
      unkeyed: 0,
      keyedSince: { seq: 1 },
    });
    const verify = await h.json('GET', '/v1/audit/verify');
    expect(verify.body).toMatchObject({ ok: true, count: 1, unkeyed: 0, lastUnkeyedSeq: null });
    const records = await h.json<{ mac: string | null }[]>('GET', '/v1/audit');
    expect(records.body[0]?.mac).toMatch(/^[0-9a-f]{64}$/);

    h.db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const dbBytes = readdirSync(h.home)
      .filter((f) => f.startsWith('orbit.db'))
      .map((f) => readFileSync(join(h.home, f)).toString('latin1'))
      .join('');
    const exported = await (await h.call('GET', '/v1/audit/export')).text();
    for (const form of [key.toString('base64'), key.toString('hex')]) {
      expect(dbBytes).not.toContain(form);
      expect(exported).not.toContain(form);
      expect(lines.join('\n')).not.toContain(form);
    }
  });

  it('marks where an upgraded log becomes keyed and reports the older records as unkeyed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orbit-api-upgrade-'));
    try {
      const first = harness({ home, start: false });
      first.service.audit.append({ actor: 'owner', action: 'bot.created' });
      // What an M7 orbitd wrote: the same record without a MAC.
      first.db.sqlite.exec('DROP TRIGGER audit_no_update');
      first.db.sqlite.exec('UPDATE audit SET mac = NULL');
      first.db.sqlite.exec(`CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
        BEGIN SELECT RAISE(ABORT, 'audit records are append-only'); END;`);
      expect(first.service.audit.status()).toMatchObject({ unkeyed: 1, keyedSince: null });
      await first.close();
      await upgraded(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  async function upgraded(home: string): Promise<void> {
    // A fresh service on the same home and database: the M8 upgrade.
    const h = (current = harness({ home }));
    const status = await h.json<{ unkeyed: number; lastUnkeyedSeq: number }>(
      'GET',
      '/v1/audit/status',
    );
    expect(status.body).toMatchObject({ keyed: true, unkeyed: 1, lastUnkeyedSeq: 1 });
    expect(h.service.audit.list().at(-1)).toMatchObject({
      seq: 2,
      action: 'audit.keyed',
      data: { keySource: 'file', unkeyedRecords: 1, lastUnkeyedSeq: 1 },
    });
    expect((await h.json('GET', '/v1/audit/verify')).body).toMatchObject({
      ok: true,
      count: 2,
      unkeyed: 1,
      keyedSince: { seq: 2 },
    });
    await h.close();
    current = undefined;
  }

  it('takes a checkpoint and verifies it, catching a later rewrite', async () => {
    const h = (current = harness());
    h.service.audit.append({ actor: 'owner', action: 'bot.created' });
    const res = await h.json<Checkpoint>('POST', '/v1/audit/checkpoint');
    expect(res.status).toBe(200);
    const cp = res.body;
    expect(cp).toMatchObject({ kind: 'orbit-audit-checkpoint', v: 1, seq: 2, count: 2 });
    expect(h.service.audit.list().at(-1)).toMatchObject({
      actor: 'owner',
      action: 'audit.checkpoint',
    });

    const ok = await h.json('POST', '/v1/audit/checkpoint/verify', cp);
    expect(ok.body).toMatchObject({ ok: true, reason: null, since: 0, chain: { ok: true } });

    const edited = await h.json('POST', '/v1/audit/checkpoint/verify', { ...cp, count: 1 });
    expect(edited.body).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not signed/) as string,
    });

    const garbage = await h.json('POST', '/v1/audit/checkpoint/verify', { seq: 1 });
    expect(garbage.status).toBe(400);

    h.db.sqlite.exec('DROP TRIGGER audit_no_delete');
    h.db.sqlite.exec('DELETE FROM audit WHERE seq = 2');
    const truncated = await h.json('POST', '/v1/audit/checkpoint/verify', cp);
    expect(truncated.body).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/log ends at #1/) as string,
    });
  });
});
