import { type PrincipalRole, roleAtLeast } from '@orbit/core';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN, type Harness, harness } from '../test/harness';
import { createApp } from './app';
import {
  CSRF_HEADER,
  type RouteDef,
  type RouteName,
  buildPath,
  routeRole,
  routes,
} from './contract';
import { buildOpenApi } from './openapi';
import { SessionStore } from './session';

/**
 * The role table (ADR-015): every route's least role, written out here so a
 * new route or a changed role is a deliberate edit of this test, and the
 * enforcement of that table for each role over every route.
 */
const EXPECTED: Record<RouteName, PrincipalRole | 'public'> = {
  health: 'public',
  createSession: 'public',
  // Reads: viewers.
  doctor: 'viewer',
  getSession: 'viewer',
  listBots: 'viewer',
  getBot: 'viewer',
  botVersions: 'viewer',
  listRuns: 'viewer',
  getRun: 'viewer',
  runEvents: 'viewer',
  listApprovals: 'viewer',
  getApproval: 'viewer',
  listRules: 'viewer',
  verifyAudit: 'viewer',
  killStatus: 'viewer',
  queue: 'viewer',
  schedules: 'viewer',
  listMemory: 'viewer',
  getMemory: 'viewer',
  runMemory: 'viewer',
  runTree: 'viewer',
  botTaint: 'viewer',
  // The Bot's computer (ADR-020): what Run events already show, read-only.
  getComputer: 'viewer',
  computerFiles: 'viewer',
  computerFile: 'viewer',
  computerActivity: 'viewer',
  triageUsage: 'viewer',
  listPlugins: 'viewer',
  getPlugin: 'viewer',
  listTriggers: 'viewer',
  pluginCatalog: 'viewer',
  events: 'viewer',
  // Anyone signed in may sign out.
  deleteSession: 'viewer',
  // Operating Runs.
  startRun: 'operator',
  stopRun: 'operator',
  resumeRun: 'operator',
  pauseRun: 'operator',
  approve: 'operator',
  deny: 'operator',
  runFeedback: 'operator',
  // Secret-ish reads stay with the owner.
  listAudit: 'owner',
  exportAudit: 'owner',
  listSecrets: 'owner',
  auditStatus: 'owner',
  // Memory text leaves Orbit in an export.
  exportMemory: 'owner',
  // Everything else changes what Orbit is or may do.
  stopDaemon: 'owner',
  createLoginTicket: 'owner',
  createBot: 'owner',
  updateBot: 'owner',
  pauseBot: 'owner',
  resumeBot: 'owner',
  // Take-over is bearer-token only on top of this (the server's owner).
  startTakeover: 'owner',
  endTakeover: 'owner',
  auditCheckpoint: 'owner',
  verifyAuditCheckpoint: 'owner',
  importMemory: 'owner',
  sweepMemory: 'owner',
  installPlugin: 'owner',
  createRule: 'owner',
  revokeRule: 'owner',
  setSecret: 'owner',
  removeSecret: 'owner',
  setKill: 'owner',
  createMemory: 'owner',
  updateMemory: 'owner',
  deleteMemory: 'owner',
  clearBotTaint: 'owner',
  proposeBot: 'owner',
  addPlugin: 'owner',
  removePlugin: 'owner',
  enablePlugin: 'owner',
  disablePlugin: 'owner',
  checkPlugin: 'owner',
  setPluginSecret: 'owner',
  removePluginSecret: 'owner',
  setPluginSetting: 'owner',
  webhookSecret: 'owner',
};

const ROLES: PrincipalRole[] = ['viewer', 'operator', 'owner'];
const entries = Object.entries(routes) as [RouteName, RouteDef][];

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('role table (ADR-015)', () => {
  it('names every route, and each route has exactly its intended least role', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(routes).sort());
    for (const [name, def] of entries) {
      const expected = EXPECTED[name];
      if (expected === 'public') expect(def.auth, name).toBe(false);
      else expect(routeRole(def), name).toBe(expected);
    }
  });

  it('OpenAPI states the role of each authenticated operation', () => {
    const doc = buildOpenApi() as {
      paths: Record<string, Record<string, { operationId: string; 'x-orbit-role'?: string }>>;
    };
    for (const ops of Object.values(doc.paths)) {
      for (const op of Object.values(ops)) {
        const expected = EXPECTED[op.operationId as RouteName];
        expect(op['x-orbit-role'], op.operationId).toBe(
          expected === 'public' ? undefined : expected,
        );
      }
    }
  });

  it('is enforced for each role on every route, before validation and handlers', async () => {
    h = harness();
    const sessions = new SessionStore({ maxSessions: 1000 });
    const app = createApp({ service: h.service, token: TOKEN, sessions });
    const send = (def: RouteDef, headers: Record<string, string>) => {
      const params = Object.fromEntries(
        [...def.path.matchAll(/\{(\w+)\}/g)].map((m) => [m[1] ?? '', 'x']),
      );
      return app.request(buildPath(def.path, params), {
        method: def.method,
        headers: { ...headers, ...(def.body ? { 'content-type': 'application/json' } : {}) },
        // An empty body: whatever passes the role check fails validation, not the guard.
        ...(def.body ? { body: '{"__invalid": true' } : {}),
      });
    };
    const refusedByRole = async (res: Response) => {
      if (res.status !== 403) return false;
      const body = (await res.clone().json()) as { error: { message: string } };
      return /^This needs the (viewer|operator|owner) role/.test(body.error.message);
    };
    for (const role of ROLES) {
      for (const [name, def] of entries) {
        const expected = EXPECTED[name];
        if (expected === 'public') continue;
        // A fresh session per call: deleteSession signs its own session out.
        const t = sessions.mintTicket({ id: `p-${role}`, name: role, role });
        const s = sessions.redeem(t.ticket)!;
        const cookie = `orbit_session_80=${s.session}`;
        const res = await send(def, { cookie, [CSRF_HEADER]: s.csrf });
        expect(await refusedByRole(res), `${role} → ${name} (${res.status})`).toBe(
          !roleAtLeast(role, expected),
        );
        await res.body?.cancel();
      }
    }
    // The bearer token is the owner: no route refuses it on role.
    for (const [name, def] of entries) {
      if (name === 'stopDaemon') continue;
      const res = await send(def, { authorization: `Bearer ${TOKEN}` });
      expect(await refusedByRole(res), name).toBe(false);
      await res.body?.cancel();
    }
  });

  it('local mode is unchanged: the token and its App sessions act as the owner', async () => {
    h = harness();
    const who = await h.json<{ via: string; principal: unknown }>('GET', '/v1/session');
    expect(who.body).toEqual({
      via: 'token',
      principal: { id: 'owner', name: 'Local owner', role: 'owner' },
    });
    expect(
      (await h.json('PUT', '/v1/secrets/LAUNCH', { value: 'launch window opens' })).status,
    ).toBe(200);
    expect(h.service.auditTail('secret.set', 5).map((r) => r.actor)).toEqual(['owner']);
    // Outside any request (scheduler, triggers) the actor stays the local owner.
    expect(h.service.actor()).toBe('owner');
  });
});
